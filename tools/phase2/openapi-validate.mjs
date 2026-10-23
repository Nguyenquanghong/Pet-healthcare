// AQ-07: strict OpenAPI 3.0 response check for the subset this repo uses. Unlike
// the lenient helper in backend/tests/http-contracts.test.mjs it rejects null
// unless the schema is nullable, follows allOf/oneOf/anyOf, checks date/date-time
// formats and additionalProperties:false. Returns a list of problems (empty = OK).
const DATE=/^\d{4}-\d{2}-\d{2}$/,DATE_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validate(spec,schema,value,at='$',problems=[]){
  if(schema.$ref){const name=schema.$ref.split('/').at(-1),target=spec.components.schemas[name];if(!target){problems.push(`${at}: unknown $ref ${name}`);return problems;}return validate(spec,{...target,...(schema.nullable?{nullable:true}:{})},value,at,problems);}
  if(value===null){if(!(schema.nullable||schema.enum?.includes(null)))problems.push(`${at}: null but not nullable`);return problems;}
  if(schema.allOf)for(const part of schema.allOf)validate(spec,part,value,at,problems);
  for(const key of ['oneOf','anyOf'])if(schema[key]&&!schema[key].some(part=>!validate(spec,part,value,at,[]).length))problems.push(`${at}: matches no ${key} branch`);
  const type=schema.type??(schema.properties?'object':undefined);
  if(type==='array'){if(!Array.isArray(value)){problems.push(`${at}: expected array`);return problems;}value.forEach((item,i)=>validate(spec,schema.items??{},item,`${at}[${i}]`,problems));}
  else if(type==='object'){
    if(typeof value!=='object'||Array.isArray(value)){problems.push(`${at}: expected object`);return problems;}
    for(const field of schema.required??[])if(!Object.hasOwn(value,field))problems.push(`${at}.${field}: required`);
    for(const [field,child] of Object.entries(schema.properties??{}))if(value[field]!==undefined)validate(spec,child,value[field],`${at}.${field}`,problems);
    if(schema.additionalProperties===false)for(const field of Object.keys(value))if(!(field in (schema.properties??{})))problems.push(`${at}.${field}: not allowed`);
    else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')for(const [field,item] of Object.entries(value))if(!(field in (schema.properties??{})))validate(spec,schema.additionalProperties,item,`${at}.${field}`,problems);
  }
  else if(type==='integer'){if(!Number.isInteger(value))problems.push(`${at}: expected integer, got ${JSON.stringify(value)}`);}
  else if(type==='number'){if(typeof value!=='number'||!Number.isFinite(value))problems.push(`${at}: expected number, got ${JSON.stringify(value)}`);}
  else if(type==='string'){if(typeof value!=='string')problems.push(`${at}: expected string, got ${JSON.stringify(value)}`);else if(schema.format==='date'&&!DATE.test(value))problems.push(`${at}: expected date, got ${value}`);else if(schema.format==='date-time'&&!DATE_TIME.test(value))problems.push(`${at}: expected date-time, got ${value}`);}
  else if(type==='boolean'){if(typeof value!=='boolean')problems.push(`${at}: expected boolean`);}
  if(schema.enum&&!schema.enum.includes(value))problems.push(`${at}: ${JSON.stringify(value)} not in enum`);
  return problems;
}

// Schema of a documented response, for a concrete path such as /pets/abc.
export function responseSchema(spec,method,path,status){
  const base=spec.servers?.[0]?.url??'',relative=path.startsWith(base)?path.slice(base.length):path,clean=relative.split('?')[0];
  const pattern=template=>new RegExp('^'+template.split(/\{[^}]+\}/).map(part=>part.replace(/[.*+?^$()|[\]\\]/g,'\\$&')).join('[^/]+')+'$');
  // Literal segments win over parameters (/pets/public before /pets/{id}).
  const entry=Object.entries(spec.paths).sort(([a],[b])=>(a.match(/\{/g)?.length??0)-(b.match(/\{/g)?.length??0)).find(([template])=>pattern(template).test(clean));
  if(!entry)throw new Error('UNDOCUMENTED_PATH '+method+' '+clean);
  const schema=entry[1][method.toLowerCase()]?.responses?.[String(status)]?.content?.['application/json']?.schema;
  if(!schema)throw new Error('UNDOCUMENTED_RESPONSE '+method+' '+entry[0]+' '+status);
  return schema;
}
