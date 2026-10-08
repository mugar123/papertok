import React from "react";
import { Composition } from "remotion";
import { Promo } from "./Promo";
import { Loop } from "./loop/Loop";
import { FPS, HEIGHT, TOTAL, WIDTH } from "./loop/timeline.ts";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Promo"
      component={Promo}
      durationInFrames={4920}
      fps={60}
      width={1920}
      height={1080}
    />
    <Composition
      id="Loop"
      component={Loop}
      durationInFrames={TOTAL}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  </>
);
