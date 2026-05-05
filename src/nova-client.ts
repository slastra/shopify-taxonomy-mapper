import {
  BedrockRuntimeClient,
  ConverseCommand,
  Tool as BedrockTool,
  ToolConfiguration,
  Message,
  ContentBlock,
  type ConverseCommandInput,
  type ToolInputSchema,
  type InferenceConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import type { DocumentType } from '@smithy/types';
import { DEFAULT_MODEL_ID } from './models.js';

const STRUCTURED_OUTPUT_TOOL_NAME = 'submit_selection';

export interface NovaConfig {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  modelId?: string;
}

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface NovaResponse {
  text?: string;
  toolCalls?: ToolCall[];
  structuredOutput?: Record<string, unknown>;
  stopReason: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
}

export interface ConverseOptions {
  tools?: BedrockTool[];
  systemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  /**
   * Static prefix prepended to the user message and followed by a cachePoint marker.
   * Identical prefixes across calls hit Bedrock's prompt cache. Nova requires ≥1024
   * cumulative tokens before the cachePoint for caching to take effect.
   */
  cacheableContext?: string;
}

export class NovaLiteClient {
  private client: BedrockRuntimeClient;
  private modelId: string;
  private conversationHistory: Message[] = [];

  constructor(config: NovaConfig = {}) {
    const region = config.region || process.env.AWS_REGION || 'us-east-1';
    const accessKeyId = config.accessKeyId || process.env['AMAZON-KEY'];
    const secretAccessKey = config.secretAccessKey || process.env['AMAZON-SECRET'];

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'AWS credentials are required. Provide them via config or set AMAZON-KEY and AMAZON-SECRET environment variables.',
      );
    }

    this.client = new BedrockRuntimeClient({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });

    this.modelId = config.modelId || process.env.NOVA_MODEL_ID || DEFAULT_MODEL_ID;
  }

  /**
   * Send a message to Bedrock. When `jsonSchema` is provided, a synthetic tool
   * is registered with that schema and `toolChoice` forces the model to call it,
   * yielding guaranteed-shape structured output via the tool's input.
   */
  async converse(userMessage: string, opts: ConverseOptions = {}): Promise<NovaResponse> {
    const { tools, systemPrompt, jsonSchema, cacheableContext } = opts;

    const userContent: ContentBlock[] = cacheableContext
      ? [
        { text: cacheableContext },
        { cachePoint: { type: 'default' } } as ContentBlock,
        { text: userMessage },
      ]
      : [{ text: userMessage }];

    this.conversationHistory.push({ role: 'user', content: userContent });

    const commandParams: ConverseCommandInput = {
      modelId: this.modelId,
      messages: this.conversationHistory,
      system: systemPrompt ? [{ text: systemPrompt }] : undefined,
      toolConfig: this.buildToolConfig(tools, jsonSchema),
      inferenceConfig: this.inferenceConfig(),
    };

    const response = await this.client.send(new ConverseCommand(commandParams));

    const outputMessage = response.output?.message;
    if (outputMessage) {
      this.conversationHistory.push(outputMessage);
    }

    return this.parseResponse(response);
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }

  getModelId(): string {
    return this.modelId;
  }

  // Bedrock rejects `temperature` + `topP` together for Anthropic Claude models.
  private inferenceConfig(): InferenceConfiguration {
    const isAnthropicClaude = this.modelId.includes('anthropic.claude');
    return {
      maxTokens: 512,
      temperature: 0.3,
      ...(isAnthropicClaude ? {} : { topP: 0.9 }),
    };
  }

  private buildToolConfig(
    extraTools: BedrockTool[] | undefined,
    jsonSchema: Record<string, unknown> | undefined,
  ): ToolConfiguration | undefined {
    if (!jsonSchema) {
      return extraTools ? { tools: extraTools } : undefined;
    }
    const inputSchema: ToolInputSchema = { json: jsonSchema as DocumentType };
    const structuredTool: BedrockTool = {
      toolSpec: {
        name: STRUCTURED_OUTPUT_TOOL_NAME,
        description: 'Submit the selected category and confidence level.',
        inputSchema,
      },
    };
    return {
      tools: extraTools ? [...extraTools, structuredTool] : [structuredTool],
      toolChoice: { tool: { name: STRUCTURED_OUTPUT_TOOL_NAME } },
    };
  }

  private parseResponse(response: { output?: { message?: Message }; stopReason?: string; usage?: unknown }): NovaResponse {
    const outputMessage = response.output?.message;
    const usage = (response.usage || {}) as {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
    };

    const result: NovaResponse = {
      stopReason: response.stopReason || 'unknown',
      usage: {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
      },
    };

    for (const content of outputMessage?.content || []) {
      if ('text' in content && content.text) {
        result.text = content.text;
      }
      if ('toolUse' in content && content.toolUse) {
        const raw = content.toolUse.input;
        const input = (typeof raw === 'object' && raw !== null && !Array.isArray(raw))
          ? raw as Record<string, unknown>
          : {};

        result.toolCalls ??= [];
        result.toolCalls.push({
          toolUseId: content.toolUse.toolUseId || '',
          name: content.toolUse.name || '',
          input,
        });

        if (content.toolUse.name === STRUCTURED_OUTPUT_TOOL_NAME) {
          result.structuredOutput = input;
        }
      }
    }

    return result;
  }
}
