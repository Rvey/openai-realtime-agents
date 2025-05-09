import React, { Suspense } from "react";
import { TranscriptProvider } from "@/app/contexts/TranscriptContext";
import { EventProvider } from "@/app/contexts/EventContext";
import CocaApp from "../CocaApp";
import { FunctionCallingProvider } from "../contexts/FunctionCallingContext";

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <TranscriptProvider>
        <EventProvider>
          <FunctionCallingProvider>
          <CocaApp />
          </FunctionCallingProvider>
        </EventProvider>
      </TranscriptProvider>
    </Suspense>
  );
}
