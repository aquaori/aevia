// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createApgSandbox } from "./apgSandbox";
import { authorizeApgEffects, createApgRuntime, type ApgHost } from "./apgRuntime";
import { compileApgSceneMutation, compileApgSceneMutations } from "./apgSceneCompiler";
import { SceneCore } from "../scene/sceneCore";
import type { ApgCatalogPlugin } from "./apgCatalog";

const plugin: ApgCatalogPlugin = {enabled:true,manifest:{manifestVersion:2,apiVersion:1,id:"test.plugin",name:"Test",version:"1.0.0",scope:"system",main:"main.js",permissions:["scene.write","ui.preview"],contributes:{commands:[{id:"run",label:"Run"}]}},program:'apg.registerCommand("run",()=>apg.preview("ok"))'};
const shape = {kind:"shape.create",shape:"rectangle",start:{x:.1,y:.1},end:{x:.4,y:.4},color:"#112233",size:3};
describe("APG isolated guest",()=>{
  it("does not expose browser, network, process or host APIs",async()=>{
    const vm=await createApgSandbox('apg.registerCommand("run",()=>apg.preview([typeof fetch,typeof document,typeof localStorage,typeof process,typeof WebSocket,typeof postMessage].join(",")))');
    try {expect(JSON.parse(vm.invoke({phase:"command",command:"run"}))[0].value).toBe("undefined,undefined,undefined,undefined,undefined,undefined");} finally {vm.dispose();}
  });
  it("interrupts infinite guest execution and releases the context",async()=>{
    const vm=await createApgSandbox('apg.registerCommand("run",()=>{while(true){}})');
    try {expect(()=>vm.invoke({phase:"command",command:"run"})).toThrow();} finally {vm.dispose();}
    expect(()=>vm.invoke({phase:"command",command:"run"})).toThrow();
  });
  it("refuses programs, inputs and results beyond the message budget",async()=>{
    await expect(createApgSandbox("/*"+"x".repeat(128*1024)+"*/")).rejects.toThrow("APG program too large");
    const vm=await createApgSandbox('apg.registerCommand("run",()=>apg.preview("x".repeat(100000)))');
    try {
      // A guest cannot talk the host into a huge payload: either the effect guard or the
      // result budget refuses it.
      expect(()=>vm.invoke({phase:"command",command:"run"})).toThrow(/APG (result too large|guest execution failed)/);
      expect(()=>vm.invoke({phase:"command",command:"run",padding:"y".repeat(600*1024)} as never)).toThrow("APG input too large");
    } finally {vm.dispose();}
  });
  it("rejects forged and unauthorized effects before host mutation",()=>{
    expect(()=>authorizeApgEffects({...plugin,manifest:{...plugin.manifest,scope:"user"}},JSON.stringify([{kind:"scene.write",value:shape}]),true)).toThrow();
    expect(()=>authorizeApgEffects(plugin,JSON.stringify([{kind:"scene.write",value:shape}]),false)).toThrow();
    expect(()=>authorizeApgEffects(plugin,JSON.stringify([{kind:"ui.preview",value:"ok"},{kind:"network.fetch",value:"bad"}]),true)).toThrow();
    expect(()=>authorizeApgEffects(plugin,JSON.stringify([{kind:"scene.write",value:shape},{kind:"scene.write",value:shape}]),true)).toThrow();
    // Effects are plain data: extra keys (including a JSON "__proto__" member) are refused
    // rather than merged into the host object.
    expect(()=>authorizeApgEffects(plugin,JSON.stringify([{kind:"ui.preview",value:"ok",extra:1}]),true)).toThrow();
    expect(()=>authorizeApgEffects(plugin,'[{"kind":"ui.preview","value":"ok","__proto__":{"polluted":true}}]',true)).toThrow();
    expect(()=>authorizeApgEffects(plugin,JSON.stringify([{kind:"ui.preview",value:{toString:1}}]),true)).toThrow();
    expect(()=>authorizeApgEffects(plugin,"not json",true)).toThrow();
  });
  it("lets a user-scoped export hand inert text to the host but never a path or a type",()=>{
    const exporter={...plugin,manifest:{...plugin.manifest,scope:"user" as const,permissions:["scene.read","ui.download"] as never,contributes:{commands:[{id:"export",label:"Export"}]}}};
    const file={name:"aevia-scene.json",mime:"application/json",text:'{"elements":2}'};
    expect(authorizeApgEffects(exporter,JSON.stringify([{kind:"ui.download",value:file}]),false)).toEqual([{kind:"ui.download",value:file}]);
    // Without the permission the effect is just another denied capability, even though the
    // plugin is installed and enabled.
    expect(()=>authorizeApgEffects(plugin,JSON.stringify([{kind:"ui.download",value:file}]),true)).toThrow("APG capability denied");
    // The host, not the guest, decides where a file goes: path separators and absolute names
    // are refused, and the MIME type is an allowlist so an export cannot become a download
    // of executable content.
    for (const name of ["../escape.json","/etc/passwd","a/b.json","", "x".repeat(65)]) {
      expect(()=>authorizeApgEffects(exporter,JSON.stringify([{kind:"ui.download",value:{...file,name}}]),false)).toThrow();
    }
    expect(()=>authorizeApgEffects(exporter,JSON.stringify([{kind:"ui.download",value:{...file,mime:"text/html"}}]),false)).toThrow();
    expect(()=>authorizeApgEffects(exporter,JSON.stringify([{kind:"ui.download",value:{...file,extra:1}}]),false)).toThrow();
    expect(()=>authorizeApgEffects(exporter,JSON.stringify([{kind:"ui.download",value:{...file,text:42}}]),false)).toThrow();
  });
  it("rejects unknown phases and unregistered command ids at the host bridge",async()=>{
    const vm=await createApgSandbox('apg.registerCommand("run",()=>apg.preview("ok"))');
    try {
      expect(()=>vm.invoke({phase:"__proto__"} as never)).toThrow();
      expect(()=>vm.invoke({phase:"constructor"} as never)).toThrow();
      expect(()=>vm.invoke({phase:"command"} as never)).toThrow();
      expect(()=>vm.invoke({phase:"command",command:"missing"})).toThrow();
      expect(()=>vm.invoke({phase:"deactivate"})).not.toThrow();
    } finally {vm.dispose();}
  });
  it("uses host IDs and replays native geometry without the plugin",()=>{
    const ctx={actorId:"actor",roomId:"room",pageId:0,allocateId:()=>"element-1",nextLamport:()=>1};
    expect(()=>compileApgSceneMutation({...shape,actorId:"forged"},ctx)).toThrow();
    expect(()=>compileApgSceneMutation({...shape,size:Infinity},ctx)).toThrow();
    const op=compileApgSceneMutation(shape,ctx).sceneOperation!;
    const a=new SceneCore(),b=new SceneCore();
    a.applyOperation(op);b.applyOperation(JSON.parse(JSON.stringify(op)));
    expect(a.getRenderIR().items.length).toBeGreaterThan(0);
    expect(a.sceneHash()).toBe(b.sceneHash());
  });
  it("compiles a shape bundle into one history group with host-owned identity",()=>{
    let n=0;
    const ctx={actorId:"actor",roomId:"room",pageId:0,allocateId:()=>"element-"+(++n),nextLamport:()=>n};
    const commands=compileApgSceneMutations([shape,{...shape,shape:"ellipse",start:{x:.5,y:.5},end:{x:.8,y:.9}}],ctx);
    expect(commands).toHaveLength(2);
    const ops=commands.map(c=>c.sceneOperation!);
    expect(new Set(ops.map(op=>op.historyGroupId)).size).toBe(1);
    expect(new Set(ops.map(op=>op.elementId)).size).toBe(2);
    expect(ops.every(op=>op.kind==="element.create")).toBe(true);
    expect(()=>compileApgSceneMutations([],ctx)).toThrow("bundle");
    expect(()=>compileApgSceneMutations(Array.from({length:9},()=>shape),ctx)).toThrow("bundle");
    expect(()=>compileApgSceneMutations([shape,{...shape,color:"red"}],ctx)).toThrow("native shape");
    expect(()=>compileApgSceneMutation([shape],ctx)).toThrow("native shape");
    const core=new SceneCore();
    for(const op of ops) core.applyOperation(op);
    expect(core.getRenderIR().items.length).toBeGreaterThan(0);
  });
  it("compiles native text and sticky notes with the same host-owned identity rules",()=>{
    let n=0;
    const ctx={actorId:"actor",roomId:"room",pageId:0,allocateId:()=>"element-"+(++n),nextLamport:()=>n};
    const note={kind:"sticky.create" as const,box:{x:.68,y:.34,width:.24,height:.2},text:"APG note",color:"#3F2E12",fillColor:"#FFF7CC",fontSize:16};
    const caption={kind:"text.create" as const,box:{x:.68,y:.56,width:.24,height:.06},text:"Placed by a plugin",color:"#334155"};
    const commands=compileApgSceneMutations([note,caption],ctx);
    expect(commands).toHaveLength(2);
    const ops=commands.map(c=>c.sceneOperation!);
    expect(new Set(ops.map(op=>op.historyGroupId)).size).toBe(1);
    const descriptors=ops.map(op=>op.kind==="element.create"?op.payload.descriptor:null);
    expect(descriptors[0]).toMatchObject({elementKind:"sticky",recipeId:"glyph",toolId:"sticky",text:"APG note"});
    expect(descriptors[0]!.box).toEqual({minX:.68,minY:.34,maxX:.92,maxY:.54,width:.24,height:.2});
    expect(descriptors[1]).toMatchObject({elementKind:"text",recipeId:"glyph",text:"Placed by a plugin"});
    expect(descriptors[1]!.style.fontSize).toBe(20);
    // SceneCore materialises the characters from descriptor.text, so the note renders anywhere.
    const core=new SceneCore();
    for(const op of ops) core.applyOperation(op);
    const ir=core.getRenderIR();
    expect(ir.items.filter(item=>item.atom.primitive==="glyph").length).toBeGreaterThan(0);
    expect(ir.items.filter(item=>item.atom.primitive==="shape").length).toBeGreaterThan(0);
    expect(()=>compileApgSceneMutations({...note,text:""},ctx)).toThrow("native text");
    expect(()=>compileApgSceneMutations({...note,box:{x:.8,y:.34,width:.4,height:.2}},ctx)).toThrow("native text");
    expect(()=>compileApgSceneMutations({...note,text:"x".repeat(201)},ctx)).toThrow("native text");
    expect(()=>compileApgSceneMutations({...note,extra:1},ctx)).toThrow("native text");
    expect(()=>compileApgSceneMutations({...caption,color:"blue"},ctx)).toThrow("native text");
  });
  it("refuses a ninth concurrent worker instead of silently dropping one",async()=>{
    const host: ApgHost={contextKey:()=>"room:0",canEdit:()=>true,readScene:async()=>null,mutate:()=>{},preview:()=>{}};
    let opened=0;
    const runtime=createApgRuntime(host,()=>{opened++;return {async invoke(){return "[]";},dispose(){}};});
    const plugins: ApgCatalogPlugin[]=Array.from({length:9},(_,i)=>({...plugin,manifest:{...plugin.manifest,id:"test.plugin"+i}}));
    try {
      runtime.reconcile({version:1,plugins});
      for(let i=0;i<8;i++) await runtime.run("test.plugin"+i,"run");
      expect(opened).toBe(8);
      await expect(runtime.run("test.plugin8","run")).rejects.toThrow("APG active worker limit");
      expect(opened).toBe(8);
    } finally {runtime.dispose();}
  });
  it("runs a real guest with a mock host and disposes on revocation",async()=>{
    const preview=vi.fn(), cleanup=vi.fn(), mutate=vi.fn();
    const host: ApgHost={contextKey:()=>"room:0",canEdit:()=>true,readScene:async()=>null,mutate,preview,cleanup};
    let vm: Awaited<ReturnType<typeof createApgSandbox>>|undefined;
    const runtime=createApgRuntime(host,()=>({async invoke(invocation,program){if(program)vm=await createApgSandbox(program);return vm!.invoke(invocation);},dispose(){vm?.dispose();}}));
    try {
      runtime.reconcile({version:1,plugins:[plugin]});
      await runtime.run("test.plugin","run");
      expect(preview).toHaveBeenCalledWith("test.plugin","ok");
      runtime.reconcile({version:1,plugins:[]});
      await expect(runtime.run("test.plugin","run")).rejects.toThrow();
      expect(cleanup).toHaveBeenCalledWith("test.plugin");
    } finally {runtime.dispose();}
  });
});
