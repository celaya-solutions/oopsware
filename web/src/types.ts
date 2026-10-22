export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Obj = { [key: string]: Json };
export interface Tool {
  name: string;
  description?: string;
  category?: string;
  kind?: string;
  inputSchema: Obj;
  effects?: Json;
  examples?: { title: string; input: Obj }[];
}
export interface Run {
  id: string;
  tool: string;
  arguments: Obj;
  targetPath?: string;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  progress?: { progress: number; total?: number; message?: string };
  result?: Obj;
  error?: string;
}
/** History rows deliberately exclude inputs and result bodies. */
export type RunSummary = Pick<
  Run,
  | "id"
  | "tool"
  | "status"
  | "createdAt"
  | "startedAt"
  | "completedAt"
  | "progress"
> & { hasResult: boolean };
export interface Target {
  name: string;
  path: string;
  directory: boolean;
  application: boolean;
  size: number;
  modified: string;
  executablePath?: string;
  applicationError?: Json;
  preview: null | {
    offset: number;
    bytes: number;
    hasMore: boolean;
    text: string | null;
    hex: string;
    strings: { offset: number; text: string }[];
  };
}
