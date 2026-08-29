import React from "react";
import { Composition } from "remotion";
import { Promo } from "./Promo";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Promo"
    component={Promo}
    durationInFrames={4920}
    fps={60}
    width={1920}
    height={1080}
  />
);
