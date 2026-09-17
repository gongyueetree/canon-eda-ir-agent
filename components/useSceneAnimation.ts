"use client";
import { useCallback, useEffect, useRef } from "react";
import type { WebGLRenderer } from "three";

/** Pause GPU rendering in hidden tabs, without tearing down model loading or the camera. */
export function useSceneAnimation(active:boolean) {
 const current=useRef(active),toggle=useRef<(show:boolean)=>void>(()=>{});
 useEffect(()=>{current.current=active;toggle.current(active);},[active]);
 return useCallback((renderer:WebGLRenderer,tick:()=>void)=>{
  const set=(show:boolean)=>renderer.setAnimationLoop(show?tick:null);
  toggle.current=set;set(current.current);
  return ()=>{set(false);if(toggle.current===set)toggle.current=()=>{};};
 },[]);
}
