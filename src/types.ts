export interface Critique {
  verdict: 'Approved' | 'Concerns' | 'Critical Issues';
  why: string;
  alternatives?: string;
  raw: string;
}

export interface Session {
  id: string;
  filePath: string;
  timestamp: Date;
}
