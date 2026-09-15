/* STEP tessellation stays off the UI thread; no network paths from input are used. */
importScripts("/occt/occt-import-js.js");
const ready = occtimportjs({ locateFile: (name) => "/occt/" + name });
onmessage = async (event) => {
  try {
    const occt = await ready;
    const result = occt.ReadStepFile(new Uint8Array(event.data), {
      linearUnit: "millimeter",
      linearDeflectionType: "bounding_box_ratio",
      linearDeflection: 0.002,
      angularDeflection: 0.5,
    });
    if (!result.success || !result.meshes?.length)
      throw new Error("STEP 文件没有可显示的网格");
    if (
      result.meshes.reduce(
        (n, m) => n + m.attributes.position.array.length,
        0,
      ) > 15000000
    )
      throw new Error("模型过于复杂，请导出较简化的 STEP");
    postMessage({ meshes: result.meshes });
  } catch (error) {
    postMessage({ error: String(error.message || error) });
  }
};
