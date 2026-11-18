export interface GuardrailViolation {
  rule: string;
  file: string;
  line: number;
  message: string;
  fix: string;
}

export interface GuardrailReport {
  ok: boolean;
  violations: GuardrailViolation[];
  checkedFiles: number;
}

export function checkSourceContent(relPath: string, code: string): GuardrailViolation[];

export function checkIpcContract(inputs: {
  mainCode: string;
  preloadCode: string;
  envDtsCode: string;
}): GuardrailViolation[];

export function runGuardrails(rootDir?: string): GuardrailReport;
