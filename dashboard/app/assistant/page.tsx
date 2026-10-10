import {redirect} from "next/navigation";
// Compatibility for previously bookmarked URLs; no separate AI page.
export default function Page(){redirect("/");}
