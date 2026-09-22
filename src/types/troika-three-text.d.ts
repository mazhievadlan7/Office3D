// troika-three-text ships no type declarations. Only the part Office3D calls
// directly is declared; drei's <Text> wraps the rest with its own types.
declare module "troika-three-text" {
  export function configureTextBuilder(config: {
    defaultFontURL?: string | null;
    unicodeFontsURL?: string | null;
    sdfGlyphSize?: number;
    sdfExponent?: number;
    sdfMargin?: number;
    textureWidth?: number;
    useWorker?: boolean;
  }): void;
}
