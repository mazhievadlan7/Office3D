/**
 * The provider a browser preference names. The server's configured provider
 * speaks (see @/lib/voice/providers; by default the local speech gateway); the
 * value is kept only so saved settings and older clients stay valid.
 */
export type VoiceReplyProvider = "local-speech";
