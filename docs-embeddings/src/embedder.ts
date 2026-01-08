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

  /**
   * Generate embedding for a single chunk using Amazon Titan
   *
   * Returns 1024-dimensional vector for titan-embed-text-v2
   */
  async generateEmbedding(content: string): Promise<number[]> {
    try {
      const input: InvokeModelCommandInput = {
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: content
        })
      };

      const command = new InvokeModelCommand(input);
      const response = await this.client.send(command);

      // Decode response body
      const responseBody = JSON.parse(
        new TextDecoder().decode(response.body)
      );

      this.callCount++;

      // Titan returns { embedding: number[], inputTextTokenCount: number }
      return responseBody.embedding;
    } catch (error) {
      console.error('Error generating Bedrock embedding:', error);
      throw error;
    }
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
