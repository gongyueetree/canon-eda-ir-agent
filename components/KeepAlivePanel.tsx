"use client";
import { useState, type ReactNode } from "react";

/** Lazy first visit; CSS hiding preserves loading work, controls and WebGL state across tabs. */
export function KeepAlivePanel({active,children}:{active:boolean;children:ReactNode}) {
 const [visited,setVisited]=useState(active);
 if(active&&!visited)setVisited(true);
 return <div hidden={!active}>{visited?children:null}</div>;
}
