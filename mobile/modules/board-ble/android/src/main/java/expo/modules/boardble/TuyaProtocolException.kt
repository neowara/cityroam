package expo.modules.boardble

/** Raised on any malformed protocol input — callers reject rather than mis-parse. */
class TuyaProtocolException(message: String) : Exception(message)
