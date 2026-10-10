/** @param {ArrayLike<number>} values @param {number} maxPoints */
export function packedEnvelope(values, maxPoints = 1200) {
  const count = values.length, budget = Math.max(4, Math.floor(maxPoints));
  const xy = new Float32Array(Math.min(count, budget)*2);
  let used = 0, min = Infinity, max = -Infinity;
  const push = (index, value) => { xy[used++] = index; xy[used++] = value; };
  if (!count) return { xy, count: 0, min: 0, max: 0 };
  if (count <= budget) {
    for (let i=0;i<count;i++) { const v=values[i]; min=Math.min(min,v); max=Math.max(max,v); push(i,v); }
  } else {
    const buckets = Math.max(1,Math.floor((budget-2)/2)); push(0,values[0]);
    for(let b=0;b<buckets;b++) {
      const start=Math.floor(b*count/buckets), end=Math.floor((b+1)*count/buckets);
      let lo=Infinity,hi=-Infinity,loIndex=start,hiIndex=start;
      for(let i=start;i<end;i++) {const v=values[i]; if(v<lo){lo=v;loIndex=i;} if(v>hi){hi=v;hiIndex=i;}}
      min=Math.min(min,lo); max=Math.max(max,hi);
      if(loIndex<hiIndex){push(loIndex,lo);push(hiIndex,hi);} else if(loIndex>hiIndex){push(hiIndex,hi);push(loIndex,lo);} else push(loIndex,lo);
    }
    push(count-1,values[count-1]);
  }
  return {xy:xy.subarray(0,used),count,min,max};
}
/** @param {number} index @param {number} sps @param {number} channel */
export function signalValue(index,sps,channel=0) {
  const t=index/sps;
  return Math.sin(2*Math.PI*37*t+channel*.3)*2 + Math.sin(2*Math.PI*113*t)*.7 + (index%4093===0?7:0);
}
export class SampleRing {
  /** @param {number} capacity */
  constructor(capacity) {this.capacity=capacity;this.values=new Float32Array(capacity);this.head=0;this.size=0;}
  /** @param {number} value */
  push(value){this.values[this.head]=value;this.head=(this.head+1)%this.capacity;this.size=Math.min(this.capacity,this.size+1);}
  ordered(){const out=new Float32Array(this.size);const start=(this.head-this.size+this.capacity)%this.capacity;const first=Math.min(this.size,this.capacity-start);out.set(this.values.subarray(start,start+first));if(first<this.size)out.set(this.values.subarray(0,this.size-first),first);return out;}
}
