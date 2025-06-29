import { isAbortError } from '@ai-sdk/provider-utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { generateId } from '@/lib/generate-id';
import { readDataStream } from '@/lib/read-data-stream';
import {
  AssistantStatus,
  CreateMessage,
  Message,
} from 'ai';

export type UseAssistantHelpers = {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setThreadId: (threadId: string | undefined) => void;
  deleteThreadFromHistory: (threadId: string) => void;
  threadId: string | undefined;
  threads: Record<string, { creationDate: string; messages: Message[] }>;
  input: string;
  append: (
    message: Message | CreateMessage,
    requestOptions?: {
      data?: Record<string, string>;
    },
  ) => Promise<void>;
  stop: () => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  handleInputChange: (
    event:
      | React.ChangeEvent<HTMLInputElement>
      | React.ChangeEvent<HTMLTextAreaElement>,
  ) => void;
  submitMessage: (
    event?: React.FormEvent<HTMLFormElement>,
    requestOptions?: {
      data?: Record<string, string>;
    },
  ) => Promise<void>;
  status: AssistantStatus;
  error: undefined | unknown;
};

export function useAssistant({
  id,
  api,
  threadId: threadIdParam,
  inputFile,
  credentials,
  clientSidePrompt,
  headers,
  body,
  onError,
}: any): UseAssistantHelpers {

  const localStorageName = `assistantThreads-${id}`;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [currentThreadId, setCurrentThreadId] = useState<string | undefined>(
    undefined,
  );
  const [status, setStatus] = useState<AssistantStatus>('awaiting_message');
  const [error, setError] = useState<undefined | Error>(undefined);

  const [threads, setThreads] = useState<
    Record<string, { creationDate: string; messages: Message[] }>
  >({});

  useEffect(() => {
    const assistantThreads = localStorage.getItem(localStorageName)
    const threadsMap = JSON.parse(assistantThreads || '{}')

    if (currentThreadId && threadsMap[currentThreadId] === undefined) {
      threadsMap[currentThreadId] = { creationDate: new Date().toISOString(), messages: [] }
      localStorage.setItem(localStorageName, JSON.stringify(threadsMap))
    }

    setThreads(threadsMap)
  }, [currentThreadId]);

  useEffect(() => {
    const assistantThreads = localStorage.getItem(localStorageName)
    const threadsMap = JSON.parse(assistantThreads || '{}')
    if (currentThreadId && threadsMap[currentThreadId] !== undefined) {
      threadsMap[currentThreadId].messages = messages
      localStorage.setItem(localStorageName, JSON.stringify(threadsMap))
      setThreads(threadsMap)
    }
  }, [messages]);

  const handleInputChange = (
    event:
      | React.ChangeEvent<HTMLInputElement>
      | React.ChangeEvent<HTMLTextAreaElement>,
  ) => {
    setInput(event.target.value);
  };

  const abortControllerRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  const append = async (
    message: Message | CreateMessage,
    requestOptions?: {
      data?: Record<string, string>;
    },
  ) => {
    setStatus('in_progress');

    setMessages(messages => [
      ...messages,
      {
        ...message,
        id: message.id ?? generateId(),
      },
    ]);

    setInput('');

    const abortController = new AbortController();

    try {
      abortControllerRef.current = abortController;

      const formData = new FormData();
      formData.append("message", message.content);
      formData.append("threadId", threadIdParam ?? currentThreadId ?? '');
      formData.append("file", inputFile || '');
      formData.append("filename", inputFile !== undefined ? inputFile.name : '');
      formData.append("clientSidePrompt", clientSidePrompt || '');

      const result = await fetch(api, {
        method: "POST",
        credentials,
        signal: abortController.signal,
        body: formData
      });

      if (result.body == null) {
        throw new Error('The response body is empty.');
      }

      const reader = result.body.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(line.slice(6));
              
              switch (eventData.event) {
                case 'response.output_text.delta': {
                  setMessages(messages => {
                    const lastMessage = messages[messages.length - 1];
                    if (lastMessage && lastMessage.role === 'assistant') {
                      return [
                        ...messages.slice(0, messages.length - 1),
                        {
                          ...lastMessage,
                          content: lastMessage.content + (eventData.data.delta || ''),
                        },
                      ];
                    } else {
                      return [
                        ...messages,
                        {
                          id: generateId(),
                          role: 'assistant',
                          content: eventData.data.delta || '',
                        },
                      ];
                    }
                  });
                  break;
                }
                
                case 'response.output_text.annotation.added': {
                  const annotation = eventData.data.annotation;
                  if (annotation && annotation.type === 'file_path') {
                    setMessages(messages => {
                      const lastMessage = messages[messages.length - 1];
                      if (lastMessage && lastMessage.role === 'assistant') {
                        const updatedContent = lastMessage.content.replace(
                          annotation.text,
                          `/api/chatbots/${id}/chat/file/${annotation.file_path.file_id}`
                        );
                        return [
                          ...messages.slice(0, messages.length - 1),
                          {
                            ...lastMessage,
                            content: updatedContent,
                          },
                        ];
                      }
                      return messages;
                    });
                  }
                  break;
                }
                
                case 'error': {
                  setError(new Error(eventData.data.message));
                  break;
                }
              }
            } catch (parseError) {
              console.error('Error parsing SSE data:', parseError);
            }
          }
        }
      }
    } catch (error) {
      if (isAbortError(error) && abortController.signal.aborted) {
        abortControllerRef.current = null;
        return;
      }

      if (onError && error instanceof Error) {
        onError(error);
      }

      setError(error as Error);
    } finally {
      abortControllerRef.current = null;
      setStatus('awaiting_message');
    }
  };

  const submitMessage = async (
    event?: React.FormEvent<HTMLFormElement>,
    requestOptions?: {
      data?: Record<string, string>;
    },
  ) => {
    event?.preventDefault?.();

    if (input === '') {
      return;
    }

    append({ role: 'user', content: input }, requestOptions);
  };

  const setThreadId = (threadId: string | undefined) => {
    setCurrentThreadId(threadId);
    if (threadId === undefined) {
      setMessages([]);
      return;
    }

    const assistantThreads = localStorage.getItem(localStorageName)
    const threads = JSON.parse(assistantThreads || '{}')
    setThreads(threads)
    if (threads[threadId] !== undefined) {
      setMessages(threads[threadId].messages)
    }
    else {
      setMessages([]);
    }
  };

  const deleteThreadFromHistory = (threadId: string) => {
    const assistantThreads = localStorage.getItem(localStorageName)
    const threads = JSON.parse(assistantThreads || '{}')
    delete threads[threadId]
    localStorage.setItem(localStorageName, JSON.stringify(threads))

    // if threadId is the current thread set to undefined
    if (currentThreadId === threadId) {
      setThreadId(undefined)
    }

    setThreads(threads)
  }

  return {
    append,
    messages,
    setMessages,
    threadId: currentThreadId,
    setThreadId,
    deleteThreadFromHistory,
    threads,
    input,
    setInput,
    handleInputChange,
    submitMessage,
    status,
    error,
    stop,
  };
}
