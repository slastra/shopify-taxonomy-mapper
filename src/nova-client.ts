import {
  BedrockRuntimeClient,
  ConverseCommand,
  Tool as BedrockTool,
  ToolConfiguration,
  Message,
  ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';

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
  };
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
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    // Amazon Nova model ID (default to Micro, can override via NOVA_MODEL_ID env var)
    this.modelId = config.modelId || process.env.NOVA_MODEL_ID || 'us.amazon.nova-micro-v1:0';
  }

  /**
   * Send a message to Nova Micro
   */
  async converse(
    userMessage: string,
    tools?: BedrockTool[],
    systemPrompt?: string,
    jsonSchema?: Record<string, unknown>,
  ): Promise<NovaResponse> {
    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: [{ text: userMessage }],
    });

    // Prepare tool configuration if tools provided
    const toolConfig: ToolConfiguration | undefined = tools
      ? { tools }
      : undefined;

    // Prepare system prompts with optional JSON schema
    let systemPrompts = systemPrompt ? [{ text: systemPrompt }] : undefined;

    // If JSON schema provided, add it to system prompt
    if (jsonSchema) {
      const schemaText = `You must respond with valid JSON matching this schema:\n${JSON.stringify(jsonSchema, null, 2)}`;
      systemPrompts = systemPrompts
        ? [...systemPrompts, { text: schemaText }]
        : [{ text: schemaText }];
    }

    const commandParams: any = {
      modelId: this.modelId,
      messages: this.conversationHistory,
      system: systemPrompts,
      toolConfig,
      inferenceConfig: {
        maxTokens: 512,   // Nova Micro optimized for tool use
        temperature: 0.2, // Low temperature for deterministic tool use
      },
    };

    // Add structured output configuration if schema provided
    if (jsonSchema) {
      commandParams.additionalModelResponseFieldPaths = ['/output'];
    }

    const command = new ConverseCommand(commandParams);

    const response = await this.client.send(command);

    // Extract response data
    const outputMessage = response.output?.message;
    const stopReason = response.stopReason || 'unknown';
    const usage = response.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // Add assistant response to history
    if (outputMessage) {
      this.conversationHistory.push(outputMessage);
    }

    // Parse response
    const result: NovaResponse = {
      stopReason,
      usage: {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0,
      },
    };

    // Extract text or tool calls
    if (outputMessage?.content) {
      for (const content of outputMessage.content) {
        if ('text' in content && content.text) {
          result.text = content.text;

          // If JSON schema was provided, try to parse structured JSON from text
          if (jsonSchema && content.text) {
            try {
              const parsed = JSON.parse(content.text);
              result.structuredOutput = parsed;
            } catch {
              // Not JSON, keep as text
            }
          }
        }
        if ('toolUse' in content && content.toolUse) {
          if (!result.toolCalls) result.toolCalls = [];
          const input = content.toolUse.input;
          result.toolCalls.push({
            toolUseId: content.toolUse.toolUseId || '',
            name: content.toolUse.name || '',
            input: (typeof input === 'object' && input !== null && !Array.isArray(input)) ? input as Record<string, unknown> : {},
          });
        }
      }
    }

    return result;
  }

  /**
   * Continue conversation with tool results
   */
  async continueWithToolResults(
    toolResults: Array<{ toolUseId: string; content: string }>,
    tools?: BedrockTool[],
    systemPrompt?: string,
  ): Promise<NovaResponse> {
    // Add tool result message to history
    const toolResultContent: ContentBlock[] = toolResults.map(result => ({
      toolResult: {
        toolUseId: result.toolUseId,
        content: [{ text: result.content }],
      },
    }));

    this.conversationHistory.push({
      role: 'user',
      content: toolResultContent,
    });

    // Prepare tool configuration if tools provided
    const toolConfig: ToolConfiguration | undefined = tools
      ? { tools }
      : undefined;

    // Prepare system prompts
    const system = systemPrompt
      ? [{ text: systemPrompt }]
      : undefined;

    // Continue conversation
    const command = new ConverseCommand({
      modelId: this.modelId,
      messages: this.conversationHistory,
      system,
      toolConfig,
      inferenceConfig: {
        maxTokens: 512,   // Nova Micro optimized for tool use
        temperature: 0.2, // Low temperature for deterministic tool use
      },
    });

    const response = await this.client.send(command);

    // Extract response
    const outputMessage = response.output?.message;
    const stopReason = response.stopReason || 'unknown';
    const usage = response.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    if (outputMessage) {
      this.conversationHistory.push(outputMessage);
    }

    const result: NovaResponse = {
      stopReason,
      usage: {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        totalTokens: usage.totalTokens || 0,
      },
    };

    if (outputMessage?.content) {
      for (const content of outputMessage.content) {
        if ('text' in content && content.text) {
          result.text = content.text;
        }
        if ('toolUse' in content && content.toolUse) {
          if (!result.toolCalls) result.toolCalls = [];
          const input = content.toolUse.input;
          result.toolCalls.push({
            toolUseId: content.toolUse.toolUseId || '',
            name: content.toolUse.name || '',
            input: (typeof input === 'object' && input !== null && !Array.isArray(input)) ? input as Record<string, unknown> : {},
          });
        }
      }
    }

    return result;
  }

  /**
   * Reset conversation history
   */
  resetConversation(): void {
    this.conversationHistory = [];
  }

  /**
   * Get conversation history
   */
  getHistory(): Message[] {
    return this.conversationHistory;
  }

  /**
   * Get the current model ID
   */
  getModelId(): string {
    return this.modelId;
  }
}
