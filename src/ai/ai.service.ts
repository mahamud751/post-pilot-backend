import {Injectable, ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';

@Injectable()
export class AiService {
  constructor(private readonly configService: ConfigService) {}

  async captionSuggestions(topic = 'your post', tone = 'friendly') {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    const model = this.configService.get<string>('OPENAI_MODEL', 'gpt-4o-mini');

    if (!apiKey) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY is not configured on the server',
      );
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.8,
        messages: [
          {
            role: 'system',
            content:
              'You are a social media copywriter. Return exactly 3 concise caption suggestions.',
          },
          {
            role: 'user',
            content: `Topic: ${topic}\nTone: ${tone}\nReturn each suggestion on a new line.`,
          },
        ],
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new ServiceUnavailableException(
        payload?.error?.message || 'AI provider request failed',
      );
    }

    const raw = String(payload?.choices?.[0]?.message?.content || '');
    const suggestions = raw
      .split('\n')
      .map(line => line.replace(/^\d+[\).\-\s]*/, '').trim())
      .filter(Boolean)
      .slice(0, 3);

    if (suggestions.length === 0) {
      throw new ServiceUnavailableException('AI provider returned empty response');
    }

    return {suggestions};
  }
}

