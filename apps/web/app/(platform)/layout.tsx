import type { ReactNode } from "react";
import { PlatformShell } from "../../components/PlatformShell";

export default function PlatformAreaLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
