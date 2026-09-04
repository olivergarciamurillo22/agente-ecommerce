import "./env-loader";
import enquirer from "enquirer";
import { systemDbHandle } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";

async function main() {
  if (process.argv.length > 2) throw new Error("No pases contraseñas ni datos por argumentos. El alta es interactiva.");
  const answer = await enquirer.prompt<{email:string;name:string;role:"owner"|"agent";password:string;confirm:string}>([
    { type:"input", name:"email", message:"Correo:" },
    { type:"input", name:"name", message:"Nombre:" },
    { type:"select", name:"role", message:"Rol:", choices:["agent","owner"] },
    { type:"password", name:"password", message:"Contraseña (mínimo 12 caracteres):" },
    { type:"password", name:"confirm", message:"Repite la contraseña:" },
  ]);
  if (answer.password !== answer.confirm) throw new Error("Las contraseñas no coinciden");
  const email=answer.email.trim().toLowerCase(), name=answer.name.trim();
  if (!email.includes("@") || !name) throw new Error("Correo y nombre son obligatorios");
  systemDbHandle().prepare("INSERT INTO users(email,name,role,password_hash) VALUES(?,?,?,?)").run(email,name,answer.role,await hashPassword(answer.password));
  console.log(`Usuario ${name} creado con rol ${answer.role}.`);
}
main().catch(e=>{console.error(e instanceof Error?e.message:e);process.exit(1)});
