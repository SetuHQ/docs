/**
 * AWS Bedrock Embedding Generation
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelCommandInput
} from '@aws-sdk/client-bedrock-runtime';

export class BedrockEmbedder {
  private client: BedrockRuntimeClient;
  private modelId: string;
  private callCount: number = 0;

  constructor(region: string = 'us-east-1', modelId: string = 'amazon.titan-embed-text-v2:0') {
    this.client = new BedrockRuntimeClient({ region });
    this.modelId = modelId;
  }

  private static readonly MAX_RETRIES = 4;

  /**
   * Generate embedding for a single chunk using Amazon Titan
   *
   * Returns 1024-dimensional vector for titan-embed-text-v2.
   * Retries with exponential backoff on throttling/transient errors.
   */
  async generateEmbedding(content: string): Promise<number[]> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= BedrockEmbedder.MAX_RETRIES; attempt++) {
      try {
        const input: InvokeModelCommandInput = {
          modelId: this.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            inputText: content,
            normalize: true
          })
        };

        const command = new InvokeModelCommand(input);
        const response = await this.client.send(command);

        const responseBody = JSON.parse(
          new TextDecoder().decode(response.body)
        );

        this.callCount++;
        return responseBody.embedding;
      } catch (error: any) {
        lastError = error;
        const isRetryable =
          error?.name === 'ThrottlingException' ||
          error?.name === 'ServiceUnavailableException' ||
          error?.name === 'ModelTimeoutException' ||
          error?.$metadata?.httpStatusCode === 429 ||
          error?.$metadata?.httpStatusCode >= 500;

        if (!isRetryable || attempt === BedrockEmbedder.MAX_RETRIES) {
          console.error(`Bedrock embedding failed (attempt ${attempt + 1}/${BedrockEmbedder.MAX_RETRIES + 1}):`, error);
          throw error;
        }

        // Full jitter: randomize within [50%, 100%] of exponential delay
        // to prevent thundering herd when multiple concurrent calls retry
        const maxDelay = Math.min(1000 * Math.pow(2, attempt), 16000);
        const delay = Math.floor(maxDelay / 2 + Math.random() * maxDelay / 2);
        console.warn(`   Bedrock throttled (attempt ${attempt + 1}), retrying in ${delay}ms...`);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Generate embeddings for multiple chunks
   *
   * Note: Bedrock Titan does NOT support batching in a single API call.
   * We must call once per chunk with rate limiting.
   */
  async generateEmbeddings(contents: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (let i = 0; i < contents.length; i++) {
      const embedding = await this.generateEmbedding(contents[i]);
      embeddings.push(embedding);

      // Rate limiting: Bedrock has soft limits
      // Conservative: 10 TPS = 100ms between calls
      if (i < contents.length - 1) {
        await this.sleep(100);
      }

      // Progress indicator
      if ((i + 1) % 50 === 0) {
        console.log(`   Generated ${i + 1}/${contents.length} embeddings...`);
      }
    }

    return embeddings;
  }

  getApiCallCount(): number {
    return this.callCount;
  }

  resetCallCount(): void {
    this.callCount = 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
