import { createOpencodeClient, OpencodeClient } from '@opencode-ai/sdk';

let client: OpencodeClient | null = null;

export async function getOpencodeClient(): Promise<OpencodeClient> {
  if (client) return client;

  const baseUrl = process.env.OPENCODE_URL ?? 'http://127.0.0.1:55599';
  try {
    client = createOpencodeClient({ baseUrl });
    const ping = await client.config.get();
    if (ping.error) {
      throw new Error(String(ping.error));
    }
    return client;
  } catch (err) {
    throw new Error(
      `Could not connect to OpenCode server at ${baseUrl}. Start it with "opencode serve" or set OPENCODE_URL.`,
    );
  }
}

export async function listProviders() {
  const sdk = await getOpencodeClient();
  try {
    const res = await sdk.config.providers();
    if (res.error) throw res.error as any;
    return (res.data as any)?.providers ?? [];
  } catch (err) {
    throw new Error('Unable to list models from OpenCode. Is the server running?');
  }
}

export async function ensureSession(sessionId?: string, title?: string): Promise<{ id: string }> {
  const sdk = await getOpencodeClient();
  if (sessionId) {
    try {
      const session = await sdk.session.get({ path: { id: sessionId } });
      if (session.error) throw session.error as any;
      if (session.data) return session.data;
    } catch {
      // fall through to create
    }
  }

  const session = await sdk.session.create({ body: { title } });
  if (session.error) {
    throw session.error as any;
  }
  if (!session.data) {
    throw new Error('Failed to create OpenCode session.');
  }
  return session.data;
}

export type BasicStreamEvent = {
  tag: 'assistant' | 'reasoning' | 'command' | 'file' | 'status' | 'error' | 'todo';
  message: string;
  timestamp: number;
};

export type PromptResult = {
  text: string;
  raw: any;
  events: BasicStreamEvent[];
  finalText: string;
};

export async function sendPrompt(params: {
  sessionId: string;
  prompt: string;
  model: string;
  onEvent?: (event: BasicStreamEvent) => void;
  timeoutMs?: number;
}): Promise<PromptResult> {
  const sdk = await getOpencodeClient();
  const { providerID, modelID } = splitModel(params.model);

  const timeoutMs = params.timeoutMs ?? 5 * 60 * 1000;
  const collectedTextParts: string[] = [];
  const collectedEvents: BasicStreamEvent[] = [];
  const pushEvent = (event: BasicStreamEvent) => {
    collectedEvents.push(event);
    params.onEvent?.(event);
  };

  // Subscribe before sending the prompt so we catch all parts
  const sse = await sdk.event.subscribe();
  const stream = sse.stream[Symbol.asyncIterator]();

  const consumePromise = (async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await stream.next();
      if (done) break;
      const event: any = value;
      if (!event?.type) continue;
      const type: string = event.type;
      const props: any = event.properties ?? {};

      // Filter to the current session
      const sessionID: string | undefined = props.sessionID ?? props.part?.sessionID ?? props.info?.id;
      if (sessionID && sessionID !== params.sessionId) {
        continue;
      }

      if (type === 'session.idle') {
        pushEvent({ tag: 'status', message: 'Session idle', timestamp: Date.now() });
        break;
      }
      if (type === 'session.error') {
        pushEvent({ tag: 'error', message: props?.message ?? 'Session error', timestamp: Date.now() });
        break;
      }

      if (type === 'message.part.updated') {
        const part = props.part;
        if (!part || typeof part !== 'object') continue;
        const ts = Date.now();
        switch (part.type) {
          case 'text': {
            const text = typeof part.text === 'string' ? part.text : '';
            if (text) collectedTextParts.push(text);
            break;
          }
          case 'reasoning': {
            const text = typeof part.text === 'string' ? part.text : 'reasoning';
            pushEvent({ tag: 'reasoning', message: text, timestamp: ts });
            break;
          }
          case 'tool': {
            const status = part.state?.status ?? 'tool';
            const title = part.state?.title ?? part.name ?? 'tool';
            const msg = `${title} (${status})`;
            pushEvent({ tag: 'command', message: msg, timestamp: ts });
            if (status === 'completed' && typeof part.state?.output === 'string') {
              pushEvent({ tag: 'assistant', message: part.state.output, timestamp: ts });
            }
            break;
          }
          case 'file':
          case 'patch':
          case 'snapshot': {
            const path = part.path ?? part.filename ?? part.files?.join(', ') ?? 'file';
            pushEvent({ tag: 'file', message: String(path), timestamp: ts });
            break;
          }
          case 'step-start':
          case 'step-finish': {
            pushEvent({ tag: 'status', message: part.type, timestamp: ts });
            break;
          }
          default: {
            pushEvent({ tag: 'status', message: part.type ?? 'part', timestamp: ts });
          }
        }
      }
    }
  })();

  const promptResponse = await sdk.session.prompt({
    path: { id: params.sessionId },
    body: {
      model: { providerID, modelID },
      parts: [{ type: 'text', text: params.prompt }],
    },
  });

  if (promptResponse.error) {
    throw promptResponse.error as any;
  }

  await Promise.race([
    consumePromise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  const responseParts = (promptResponse.data as any)?.parts ?? [];
  const finalTextFromResponse = responseParts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('\n');

  const text = (collectedTextParts.length ? collectedTextParts.join('\n') : finalTextFromResponse).trim();

  return { text, raw: promptResponse, events: collectedEvents, finalText: finalTextFromResponse };
}

export function splitModel(model: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = model.split('/');
  const modelID = rest.join('/') || providerID;
  return { providerID, modelID };
}
