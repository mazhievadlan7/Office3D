
import { t } from "@/lib/i18n";
export type CuratedVoiceOption = {
  id: string | null;
  label: string;
  description: string;
};

export const CURATED_ELEVENLABS_VOICES: CuratedVoiceOption[] = [
  {
    id: null,
    label: "Rachel",
    description: t("voices.balanced"),
  },
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    label: "Bella",
    description: t("voices.warm"),
  },
  {
    id: "MF3mGyEYCl7XYWbV9V6O",
    label: "Elli",
    description: t("voices.clear"),
  },
  {
    id: "ErXwobaYiN019PkySvjV",
    label: "Antoni",
    description: t("voices.calm"),
  },
  {
    id: "TxGEqnHWrfWFTfGW9XjX",
    label: "Josh",
    description: t("voices.steady"),
  },
  {
    id: "pNInz6obpgDQGcFmaJgB",
    label: "Adam",
    description: t("voices.deep"),
  },
];
