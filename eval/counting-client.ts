import { JevClient, type ChoiceQuestion, type DecisionResponse } from '../src/jev-client.js';

/** Tallies requests and spend so eval scripts can report usage. */
export class CountingJevClient extends JevClient {
  requests = 0;
  cost = 0;

  override async decide(state: Record<string, unknown>, questions: Record<string, ChoiceQuestion>): Promise<DecisionResponse> {
    const response = await super.decide(state, questions);
    this.requests++;
    this.cost += response.usage.cost;
    return response;
  }

  reset(): void {
    this.requests = 0;
    this.cost = 0;
  }
}
