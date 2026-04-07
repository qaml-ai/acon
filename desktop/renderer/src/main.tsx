import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/theme-provider';
import { AppearanceProvider } from '@/components/appearance-provider';
import { App } from './App';
import '../../../src/styles/globals.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <AppearanceProvider>
        <App />
        <Toaster />
      </AppearanceProvider>
    </ThemeProvider>
  </React.StrictMode>
);
