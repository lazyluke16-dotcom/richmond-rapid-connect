import { DemoCommercial } from "./DemoCommercial";
import { DemoRealWorldV2 } from "./DemoRealWorldV2";
import type { AcquisitionEventName } from "@/lib/acquisition";
import type { DemoVariant } from "@/lib/demo-variants";

export function DemoExperience({
  variant,
  open,
  onClose,
  onTrack,
  onSignup,
}: {
  variant: DemoVariant;
  open: boolean;
  onClose: () => void;
  onTrack: (event: AcquisitionEventName) => void;
  onSignup: () => void;
}) {
  if (variant === "demo-original") {
    return <DemoCommercial open={open} onClose={onClose} onTrack={onTrack} onSignup={onSignup} />;
  }
  return <DemoRealWorldV2 open={open} onClose={onClose} onTrack={onTrack} onSignup={onSignup} />;
}
