// The one thing this library throws.
//
// A refusal is a value, not an exception: "wrong password" is an ordinary
// outcome of a sign-in form and belongs in the return type where the caller
// cannot skip it. An exception is reserved for the case where NOTHING IS
// KNOWN — the service was unreachable, timed out, or answered something that
// is not an answer.

/**
 * The identity service could not be reached, or answered something that is not
 * an answer.
 *
 * Nobody did anything wrong and nothing is known. Callers render "sign-in is
 * temporarily unavailable" rather than "your password is wrong", and — for
 * logout — clear local session state anyway.
 */
export class ServiceUnavailableError extends Error {
    /**
     * The HTTP status, when the service answered with one that is not an
     * answer (a 5xx, say). `null` for a transport failure or timeout, where
     * there was no response at all.
     */
    readonly status: number | null;

    constructor(message = 'the identity service is unreachable', status: number | null = null) {
        super(message);
        this.name = 'ServiceUnavailableError';
        this.status = status;
        // Restores the prototype chain when this is compiled down to ES5, so
        // `instanceof` keeps working for consumers on older targets.
        Object.setPrototypeOf(this, ServiceUnavailableError.prototype);
    }
}
