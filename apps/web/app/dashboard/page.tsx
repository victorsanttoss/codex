import { redirect } from "next/navigation";

// O dashboard antigo foi substituído pela área do cliente (/inicio) no M14.
export default function DashboardRedirect() {
  redirect("/inicio");
}
