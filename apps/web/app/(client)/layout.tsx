import type { ReactNode } from "react";
import { ClientShell } from "../../components/ClientShell";

export default function ClientAreaLayout({ children }: { children: ReactNode }) {
  return <ClientShell>{children}</ClientShell>;
}
