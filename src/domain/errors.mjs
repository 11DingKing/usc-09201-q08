export class GateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GateError';
    this.code = code;
    this.details = details;
  }
}
