import type { InputAsset } from '../eda/types';
export type AssetKind = 'symbol' | 'footprint' | 'model';
export type Origin = { project: string; bundleId: string; path: string; sourceHash: string; reference: string; nativeId?: string };
export type OfficialMatch = { status: 'match' | 'different' | 'found' | 'missing' | 'unknown' | 'unmapped'; name: string; revision?: string; url?: string; sha256?: string; fingerprint?: string; message?: string };
export type DesignAsset = {
 id: string; kind: AssetKind; name: string; mpn: string; manufacturer: string; identityConfirmed: boolean; identityScope?: string;
 fingerprint: string; fileHash?: string; fileName?: string; size?: number; format: string;
 dependencies?: Array<{path:string;fileHash?:string;offset:number[];scale:number[];rotation:number[]}>;
 origins: Origin[]; warnings: string[]; official?: OfficialMatch;
};
export type ExtractedAsset = DesignAsset & { file?: InputAsset };
export type AssetRecord = DesignAsset & { status: 'CANDIDATE' | 'APPROVED' | 'REJECTED'; revision: number; storage: 'file' | 'official'; sourceUrl: string; license: string; reviewNote: string };
export const identityKey = (manufacturer:string,mpn:string) => JSON.stringify([manufacturer.trim().toUpperCase(),mpn.trim().toUpperCase()]);
export const originKey = (o:Origin) => JSON.stringify([o.bundleId,o.path,o.reference,o.nativeId]);
