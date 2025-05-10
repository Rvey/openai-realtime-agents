import React, { Suspense } from "react";
import { TranscriptProvider } from "@/app/contexts/TranscriptContext";
import { EventProvider } from "@/app/contexts/EventContext";
import App from "./App";
import { FunctionCallingProvider } from "./contexts/FunctionCallingContext";

export default function Page() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <TranscriptProvider>
        <EventProvider>
          <FunctionCallingProvider>
            <App />
          </FunctionCallingProvider>
        </EventProvider>
      </TranscriptProvider>
    </Suspense>
  );
}
