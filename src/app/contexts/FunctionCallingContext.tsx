"use client"

import React, { createContext, useContext, useState, FC, PropsWithChildren } from "react";

// Define the structure for a function and its arguments
type AssistantFunction = {
  name: string;
  arguments: Record<string, any>;
};

type FunctionCallingContextValue = {
  functions: AssistantFunction[];
  addFunction: (name: string, args: Record<string, any>) => void;
  updateFunctionArgs: (name: string, newArgs: Record<string, any>) => void;
};

const FunctionCallingContext = createContext<FunctionCallingContextValue | undefined>(undefined);

export const FunctionCallingProvider: FC<PropsWithChildren> = ({ children }) => {
  const [functions, setFunctions] = useState<AssistantFunction[]>([]);

  const addFunction: FunctionCallingContextValue["addFunction"] = (name, args) => {
    setFunctions((prev) => {
      if (prev.some((func) => func.name === name)) {
        console.warn(`[addFunction] Function with name=${name} already exists.`);
        return prev;
      }

      const newFunction: AssistantFunction = {
        name,
        arguments: args,
      };

      return [...prev, newFunction];
    });
  };

  const updateFunctionArgs: FunctionCallingContextValue["updateFunctionArgs"] = (name, newArgs) => {
    setFunctions((prev) =>
      prev.map((func) =>
        func.name === name ? { ...func, arguments: { ...func.arguments, ...newArgs } } : func
      )
    );
  };

  return (
    <FunctionCallingContext.Provider value={{ functions, addFunction, updateFunctionArgs }}>
      {children}
    </FunctionCallingContext.Provider>
  );
};

export function useFunctionCalling() {
  const context = useContext(FunctionCallingContext);
  if (!context) {
    throw new Error("useFunctionCalling must be used within a FunctionCallingProvider");
  }
  return context;
}