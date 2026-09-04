import { NextResponse, type NextRequest } from "next/server";
import { getConversationById, getMessages, insertMessage, enqueueOutbox, getLastInboundAt } from "@/lib/db";
import { requireStaff } from "@/lib/auth/guard";
import { audit } from "@/lib/workspace";

export const dynamic = "force-dynamic";
interface RouteContext { params: Promise<{ conversationId: string }> }

export async function GET(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const auth = requireStaff(req); if (!auth.ok) return auth.response;
  const id = Number.parseInt((await params).conversationId, 10);
  if (Number.isNaN(id)) return NextResponse.json({ ok:false,error:"id inválido" },{status:400});
  return NextResponse.json({ messages: getMessages(id, 200) });
}

export async function POST(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const id = Number.parseInt((await params).conversationId, 10);
  if (Number.isNaN(id)) return NextResponse.json({ ok:false,error:"id inválido" },{status:400});
  let body: {content?:string};
  try { body=await req.json(); } catch { return NextResponse.json({ok:false,error:"JSON inválido"},{status:400}); }
  const content=typeof body?.content==="string"?body.content.trim():"";
  if (!content) return NextResponse.json({ok:false,error:"contenido vacío"},{status:400});
  const auth=requireStaff(req); if(!auth.ok)return auth.response;
  const conv=getConversationById(id);
  if(!conv)return NextResponse.json({ok:false,error:"conversación no encontrada"},{status:404});
  const lastInbound=getLastInboundAt(id);
  if(!lastInbound||lastInbound<Math.floor(Date.now()/1000)-86400)return NextResponse.json({ok:false,error:"La ventana de 24 h está cerrada. Escala el caso a Pedro."},{status:409});
  const messageId=insertMessage(id,"human",content);
  enqueueOutbox(id,conv.phone,content);
  audit(auth.user,"send_message","conversation",id,{messageId});
  return NextResponse.json({ok:true,messageId});
}
