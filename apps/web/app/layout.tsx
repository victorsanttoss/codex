import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";

// Montserrat do design V4, instalada com o lockfile (sem download no build).
// A licença SIL OFL 1.1 acompanha o pacote e public/fonts/Montserrat-OFL.txt.
const montserrat = localFont({
  src: "../node_modules/@fontsource-variable/montserrat/files/montserrat-latin-wght-normal.woff2",
  weight: "400 800",
  style: "normal",
  variable: "--font-montserrat",
  display: "swap",
});

export const metadata = {
  title: "SDR de IA · V4",
  description: "Plataforma SDR de IA multi-tenant no WhatsApp",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={montserrat.variable}>
      <body>{children}</body>
    </html>
  );
}
