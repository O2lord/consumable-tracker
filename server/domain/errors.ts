// Typed domain errors. Services throw these; route handlers map `code` to an HTTP status
// and a clear message for the scanner screen.

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super("VALIDATION", message);
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    super("NOT_FOUND", `${what} not found`);
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(message = "You are not allowed to do this") {
    super("PERMISSION_DENIED", message);
  }
}

/** The server is missing configuration (for example a service role key). Not the user's fault. */
export class ConfigurationError extends DomainError {
  constructor(message: string) {
    super("CONFIGURATION", message);
  }
}

export class InvalidSerialError extends DomainError {
  constructor(serial: string) {
    super("INVALID_SERIAL", `"${serial}" is not a valid serial (check the label and rescan)`);
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(
    readonly from: string,
    readonly action: string,
  ) {
    super(
      "INVALID_TRANSITION",
      `Cannot ${action.toLowerCase().replace(/_/g, " ")} an item that is ${from.toLowerCase().replace(/_/g, " ")}`,
    );
  }
}

export class WrongLocationError extends DomainError {
  constructor(message = "This item is not at this location") {
    super("WRONG_LOCATION", message);
  }
}

/** A scan that belongs to a different transfer (wrong slip or wrong destination). */
export class WrongTransferError extends DomainError {
  constructor(message = "This item is not on this transfer") {
    super("WRONG_TRANSFER", message);
  }
}

/** The transfer is not in a status that allows this step (for example scanning after it closed). */
export class TransferStatusError extends DomainError {
  constructor(message: string) {
    super("TRANSFER_STATUS", message);
  }
}

/** The stock request is not in a status that allows this step (for example approving a cancelled request). */
export class RequestStatusError extends DomainError {
  constructor(message: string) {
    super("REQUEST_STATUS", message);
  }
}

export class AlreadyIssuedError extends DomainError {
  constructor(message = "This item has already been issued") {
    super("ALREADY_ISSUED", message);
  }
}

export class ExpiredStockError extends DomainError {
  constructor(message = "This stock has expired") {
    super("EXPIRED_STOCK", message);
  }
}

/** The bottle's container type is not what the test needs. A supervisor can override. */
export class ContainerMismatchError extends DomainError {
  constructor(message: string) {
    super("CONTAINER_MISMATCH", message);
  }
}

/** The issue policy requires payment and the reference is known to be unpaid. A supervisor can override. */
export class PaymentRequiredError extends DomainError {
  constructor(message: string) {
    super("PAYMENT_REQUIRED", message);
  }
}

/** One bottle can serve several investigations of the same patient, never different patients. */
export class PatientMismatchError extends DomainError {
  constructor(message: string) {
    super("PATIENT_MISMATCH", message);
  }
}
