import { redirect } from "next/navigation";

// A raiz manda para a área do cliente; o ClientShell redireciona ao /login se não
// houver sessão (o guard real de dados é a API, com @Roles em cada endpoint).
export default function Home() {
  redirect("/inicio");
}
