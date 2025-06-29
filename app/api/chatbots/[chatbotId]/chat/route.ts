import { db } from "@/lib/db"
import OpenAI from "openai"
import { z } from "zod"
import { getUserSubscriptionPlan } from "@/lib/subscription";
import { zfd } from "zod-form-data";
import { fileTypesFullList } from "@/lib/validations/codeInterpreter";
import { fileTypes as searchFile } from "@/lib/validations/fileSearch";
import { getClientIP } from "@/lib/getIP";

export const maxDuration = 300;

const routeContextSchema = z.object({
    params: z.object({
        chatbotId: z.string(),
    }),
})

const schema = zfd.formData({
    threadId: z.string().or(z.undefined()),
    message: zfd.text(),
    clientSidePrompt: z.string().or(z.undefined()),
    file: z.instanceof(Blob).or(z.string()),
    filename: z.string(),
});

export async function OPTIONS(req: Request) {
    return new Response('Ok', { status: 200 })
}

export async function POST(
    req: Request,
    context: z.infer<typeof routeContextSchema>
) {
    try {
        const { params } = routeContextSchema.parse(context)

        const chatbot = await db.chatbot.findUnique({
            select: {
                id: true,
                openaiKey: true,
                userId: true,
                openaiId: true,
                chatbotErrorMessage: true,
                maxCompletionTokens: true,
                maxPromptTokens: true,
                prompt: true,
                name: true,
            },
            where: {
                id: params.chatbotId,
            },
        })

        if (!chatbot) {
            return new Response(null, { status: 404 })
        }

        const openai = new OpenAI({
            apiKey: chatbot.openaiKey,
        })

        const input = await req.formData();
        const data = schema.parse(input);

        const messages = [
            {
                role: "system" as const,
                content: chatbot.prompt || "You are a helpful assistant."
            },
            {
                role: "user" as const,
                content: data.message.toString()
            }
        ];

        let tools: any[] = [];
        let fileAttachments: any[] = [];

        if (data.filename !== '' && data.file instanceof Blob && data.file.size > 0) {
            const file = new File([data.file], data.filename, { type: data.file.type });
            
            const openAiFile = await openai.files.create({
                file,
                purpose: "assistants"
            });

            const fileExtension = data.filename.split('.').pop()?.toLowerCase();
            
            if (fileTypesFullList.includes(fileExtension!)) {
                tools.push({ type: "code_interpreter" });
            }
            if (searchFile.includes(fileExtension!)) {
                tools.push({ type: "file_search" });
                fileAttachments.push({
                    file_id: openAiFile.id,
                    tools: [{ type: "file_search" }]
                });
            }
        }

        if (!tools.some(t => t.type === "file_search")) {
            tools.push({ type: "file_search" });
        }
        if (!tools.some(t => t.type === "code_interpreter")) {
            tools.push({ type: "code_interpreter" });
        }

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const plan = await getUserSubscriptionPlan(chatbot.userId)
                    if (plan.unlimitedMessages === false) {
                        const messageCount = await db.message.count({
                            where: {
                                userId: chatbot.userId,
                                createdAt: {
                                    gte: new Date(new Date().setDate(new Date().getDate() - 30))
                                }
                            }
                        })
                        
                        if (messageCount >= plan.maxMessagesPerMonth!) {
                            const errorData = JSON.stringify({
                                event: "error",
                                data: { message: "You have reached your monthly message limit. Upgrade your plan to continue using your chatbot." }
                            });
                            controller.enqueue(`data: ${errorData}\n\n`);
                            controller.close();
                            return;
                        }
                    }

                    const events = await openai.responses.create({
                        model: "gpt-4o",
                        input: messages,
                        tools,
                        stream: true,
                        parallel_tool_calls: false,
                    });

                    let assistantResponse = "";

                    for await (const event of events) {
                        const eventData = JSON.stringify({
                            event: event.type,
                            data: event,
                        });
                        controller.enqueue(`data: ${eventData}\n\n`);

                        if (event.type === "response.output_text.delta") {
                            assistantResponse += event.delta || "";
                        }
                    }

                    await db.message.create({
                        data: {
                            chatbotId: params.chatbotId,
                            userId: chatbot.userId,
                            message: data.message,
                            threadId: data.threadId || "",
                            response: assistantResponse,
                            userIP: getClientIP(),
                            from: req.headers.get("origin") || "unknown",
                        }
                    });

                    controller.close();
                } catch (error) {
                    console.error(error);
                    const errorData = JSON.stringify({
                        event: "error",
                        data: { message: chatbot.chatbotErrorMessage }
                    });
                    controller.enqueue(`data: ${errorData}\n\n`);
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
            },
        });

    } catch (error) {
        console.error(error)
        if (error instanceof z.ZodError) {
            return new Response(JSON.stringify(error.issues), { status: 422 })
        }

        if (error instanceof OpenAI.APIError) {
            return new Response(error.message, { status: 401 })
        }

        return new Response(null, { status: 500 })
    }
}
