import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { UIProviders } from "./ui-patterns/providers";
import "./shadcn.css";
const client = new QueryClient({defaultOptions:{queries:{retry:1,refetchOnWindowFocus:false,staleTime:15000},mutations:{retry:false}}});
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><UIProviders><QueryClientProvider client={client}><App /></QueryClientProvider></UIProviders></React.StrictMode>);
