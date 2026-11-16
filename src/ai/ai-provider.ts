import {Injectable, ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';

export type JsonSchema = Record<string, unknown>;

export type AiResult = {
  json: unknown;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
};

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generateJson(system: string, prompt: string, schema: JsonSchema): Promise<AiResult>;
}

/** USD per 1M tokens [input, output]. Estimates for cost tracking; check provider pricing. */
const PRICES: Record<string, [number, number]> = {
  'gemini-2.0-flash': [0.1, 0.4],
  'gemini-2.0-flash-lite': [0.075, 0.3],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4.1-mini': [0.4, 1.6],
};

export function estimateCostUsd(model: string, input: number | null, output: number | null) {
  const price = PRICES[model] || PRICES[model.replace(/-\d{3,}.*$/, '')];
  if (!price || input === null || output === null) {
    return null;
  }
  return (input * price[0] + output * price[1]) / 1_000_000;
}

const TIMEOUT_MS = 60_000;

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...headers},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServiceUnavailableException(`AI provider unreachable: ${error instanceof Error ? error.message : error}`);
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    throw new ServiceUnavailableException(payload?.error?.message || `AI provider error (${response.status})`);
  }
  return payload;
}

function parseJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new ServiceUnavailableException('The AI returned malformed output. Please try again.');
  }
}

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async generateJson(system: string, prompt: string, schema: JsonSchema): Promise<AiResult> {
    const payload = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        systemInstruction: {parts: [{text: system}]},
        contents: [{role: 'user', parts: [{text: prompt}]}],
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      },
      {'x-goog-api-key': this.apiKey},
    );
    const text = (payload?.candidates?.[0]?.content?.parts || []).map((p: {text?: string}) => p.text || '').join('');
    if (!text) {
      throw new ServiceUnavailableException(
        payload?.promptFeedback?.blockReason
          ? `The AI declined this request (${payload.promptFeedback.blockReason}).`
          : 'The AI returned an empty response.',
      );
    }
    return {
      json: parseJson(text),
      provider: this.name,
      model: this.model,
      inputTokens: payload?.usageMetadata?.promptTokenCount ?? null,
      outputTokens: payload?.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
}

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai';
  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async generateJson(system: string, prompt: string, schema: JsonSchema): Promise<AiResult> {
    const payload = await postJson(
      'https://api.openai.com/v1/chat/completions',
      {
        model: this.model,
        temperature: 0.8,
        response_format: {type: 'json_object'},
        messages: [
          {role: 'system', content: `${system}\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}`},
          {role: 'user', content: prompt},
        ],
      },
      {Authorization: `Bearer ${this.apiKey}`},
    );
    return {
      json: parseJson(String(payload?.choices?.[0]?.message?.content || '')),
      provider: this.name,
      model: this.model,
      inputTokens: payload?.usage?.prompt_tokens ?? null,
      outputTokens: payload?.usage?.completion_tokens ?? null,
    };
  }
}

/** Picks the configured provider; tests override this class with a fake. */
@Injectable()
export class AiProviderRegistry {
  constructor(private readonly config: ConfigService) {}

  get(): AiProvider {
    const preferred = this.config.get<string>('AI_PROVIDER');
    const gemini = this.config.get<string>('GEMINI_API_KEY');
    const openai = this.config.get<string>('OPENAI_API_KEY');
    if (gemini && preferred !== 'openai') {
      return new GeminiProvider(gemini, this.config.get<string>('GEMINI_MODEL') || 'gemini-3.8-flash');
    }
    if (openai) {
      return new OpenAiProvider(openai, this.config.get<string>('OPENAI_MODEL') || 'gpt-4o-mini');
    }
    throw new ServiceUnavailableException('AI is not configured: set GEMINI_API_KEY or OPENAI_API_KEY on the server.');
  }
}
