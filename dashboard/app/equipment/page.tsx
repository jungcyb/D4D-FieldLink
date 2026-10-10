import { Suspense } from "react";
import Dashboard from "@/components/dashboard";
export default function Page(){return <Suspense fallback={<p>장비·센서 화면을 불러옵니다…</p>}><Dashboard view="equipment"/></Suspense>;}
