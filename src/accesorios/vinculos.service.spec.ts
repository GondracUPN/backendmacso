import { ConflictException } from '@nestjs/common';
import { VinculosService } from './vinculos.service';
import { proposeAccessory } from './vinculos-rules';
import { AccesorioVinculoPropuesta as Proposal, AccesorioVinculoAuditoria as Audit, AccesorioVinculoOperacion as Operation } from './accesorio-vinculo.entity';
import { AccesorioReferencia as Ref } from './accesorio-referencia.entity';
import { Producto } from '../producto/producto.entity';
import { ProductoValor } from '../producto/producto-valor.entity';
import { allocateAccessory, accessoryAvailable } from '../venta/accessory-quote';

const lot = (id = 1, code = 7, owner = 'Gonzalo'): any => ({ id, tipo:'accesorios', referenciaId:null, codigoInventario:code, vendedor:owner, stockInicial:2, stockActual:2, estado:'nuevo', detalle:{ modelo:'Apple cable original USB-C 60W', gama:'cable', descripcionOtro:'USB-C 60W 1m', modelosCompatibles:['Mac'] }, valor:{id, monedaCompra:'USD', tipoCambioCompra:null, valorProducto:10, valorSoles:37, costoTotal:37} });
const clone = (value: any) => JSON.parse(JSON.stringify(value));
function fixture(initial = [lot()]) {
  let state: any = { products:clone(initial), refs:[], proposals:[], audits:[], operations:[], values:clone(initial.map(row=>row.valor)) };
  const mutations: any[]=[];
  const key = (entity: any) => entity===Producto?'products':entity===Ref?'refs':entity===Proposal?'proposals':entity===Audit?'audits':entity===ProductoValor?'values':entity===Operation?'operations': (()=>{throw new Error('Escritura/lectura inesperada de negocio');})();
  const matches = (row: any, where: any) => Object.entries(where || {}).every(([k,v]: any) => v?._type === 'in' ? v._value.includes(row[k]) : v?._type === 'isNull' ? row[k]==null : row[k]===v);
  const repo = (entity: any): any => {
    const name=key(entity);
    const find=async (options: any={}) => { let rows=state[name].filter(row=>matches(row,options.where)); if(options.order?.id) rows=[...rows].sort((a,b)=>options.order.id==='DESC'? b.id-a.id:a.id-b.id); return clone(rows); };
    const save=async (value: any): Promise<any> => { if(Array.isArray(value)) return Promise.all(value.map(save)); const item=clone(value); if(!item.id) item.id=Math.max(0,...state[name].map(row=>row.id))+1; const old=state[name].find(row=>row.id===item.id); if(old) Object.assign(old,item); else state[name].push(item); return clone(item); };
    return {create:(value)=>clone(value), find, findOne:async options=>(await find(options))[0]||null, findOneBy:async where=>(await find({where}))[0]||null, save,
      update:async (criteria,values)=>{mutations.push({name,values});let affected=0; for(const row of state[name]) if(matches(row,typeof criteria==='number'?{id:criteria}:criteria)){Object.assign(row,clone(values));affected++;} return {affected};}};
  };
  const em: any={getRepository:repo, query:jest.fn(async()=>[]), transaction:async run=>{const before=clone(state);try{return await run(em);}catch(error){state=before;throw error;}}};
  const references: any={createReference:jest.fn(async data=>repo(Ref).save({...data,activo:true}))};
  const ds: any={transaction:em.transaction,getRepository:repo};
  return { service:new VinculosService(ds,references), em, references, mutations, state:()=>state, repo };
}

test('propone una nueva y una existente por identidad normalizada sin inferir originalidad de la marca',()=>{
  const data=proposeAccessory([lot()],[]);
  expect(data).toMatchObject({puntuacion:90,ambigua:false,referenciaId:null});
  expect(proposeAccessory([lot()],[{...data.datosReferenciaPropuesta,id:10,activo:true} as any])).toMatchObject({referenciaId:10,puntuacion:100});
  const unknown=lot();unknown.detalle.modelo='Apple cable USB-C 60W';
  expect(proposeAccessory([unknown],[])).toMatchObject({ambigua:true,motivo:expect.stringContaining('originalidad desconocida')});
});
test.each([
  ['estado vacío', p=>p.estado=''], ['variante faltante',p=>{p.detalle.modelo='Apple pencil original';p.detalle.gama='pencil';p.detalle.descripcionOtro='';}],
  ['potencia faltante',p=>{p.detalle.modelo='Apple cable original USB-C';p.detalle.descripcionOtro='USB-C';}],
  ['conector faltante',p=>{p.detalle.modelo='Apple cable original 60W';p.detalle.descripcionOtro='60W';}],
])('ambigüedad explícita: %s',(reason,change)=>{const p=lot();change(p);expect(proposeAccessory([p],[])).toMatchObject({ambigua:true,puntuacion:expect.any(Number),motivo:expect.stringContaining(reason)});});
test('detalle mixto del mismo código requiere revisión incluso entre compradores',()=>{
 const other=lot(2,7,'Renato');other.detalle.descripcionOtro='USB-C 100W';expect(proposeAccessory([lot()],[],[lot(),other]).motivo).toContain('detalles distintos');
});
test('regenera sin duplicar, conserva agotados, separa posibles duplicados y vuelve obsoletas las cambiadas',async()=>{
 const empty=lot(2,8);empty.stockActual=0;const f=fixture([lot(),empty]);expect(await f.service.generar()).toMatchObject({nuevas:2});
 expect(f.state().proposals.every(p=>p.posibleDuplicado)).toBe(true);
 expect(await f.service.generar()).toMatchObject({nuevas:0,actualizadas:2});
 f.state().products[0].stockActual=1;expect(await f.service.generar()).toMatchObject({nuevas:1,obsoletas:1});
 f.state().products[0].archivadoAt='2026-01-01';expect(await f.service.generar()).toMatchObject({obsoletas:1});
});
test('rechazar mantiene la decisión al regenerar el mismo grupo',async()=>{
 const f=fixture();await f.service.generar();await f.service.rechazar(1,'admin','verificar');expect(await f.service.generar()).toMatchObject({nuevas:0,rechazadasConservadas:1});expect(f.state().proposals[0].resueltoPor).toBe('admin');
});
test('aplicar solo cambia referenciaId, conserva códigos/costos/historial y token antiguo cambia; deshacer audita sin borrar referencia',async()=>{
 const f=fixture([lot(),lot(2),lot(3,7,'Renato')]);await f.service.generar();
 const before=clone(f.state().products);
 const token=allocateAccessory(before,before[0],2).cotizacionToken;
 const dto={propuestaIds:[1],idempotencyKey:'apply-test-1'};const result=await f.service.aplicar(dto,'1:admin');
 expect(result.aplicadas[0].productoIds).toEqual([1,2]);expect(f.state().products[2].referenciaId).toBeNull();
 expect(f.state().products.map(({referenciaId,...p})=>p)).toEqual(before.map(({referenciaId,...p})=>p));
expect(f.state().values).toEqual(before.map(p=>p.valor));
 expect(f.mutations.filter(m=>m.name==='products').every(m=>Object.keys(m.values).join()==='referenciaId')).toBe(true);
 expect(allocateAccessory(f.state().products,f.state().products[0],2).cotizacionToken).not.toBe(token);
 expect(allocateAccessory(f.state().products,f.state().products[0],3).lotes.map(p=>p.productoId)).toEqual([1,2]);
 expect(await f.service.aplicar(dto,'1:admin')).toEqual(result);expect(f.references.createReference).toHaveBeenCalledTimes(1);
 await expect(f.service.aplicar({...dto,propuestaIds:[2]},'admin')).rejects.toBeInstanceOf(ConflictException);
 await f.service.deshacer({auditoriaIds:result.aplicadas[0].auditoriaIds},'admin');expect(f.state().products).toEqual(before);expect(f.state().refs).toHaveLength(1);expect(f.state().audits).toHaveLength(4);
 expect((await f.service.deshacer({auditoriaIds:result.aplicadas[0].auditoriaIds},'admin')).yaDeshechas).toHaveLength(2);
});
test('todo o nada revierte la primera propuesta si cambia la segunda; parcial requiere parámetro explícito',async()=>{
 const f=fixture([lot(),lot(2,8)]);await f.service.generar();f.state().products[1].stockActual=1;
 const dto={propuestaIds:[1,2],idempotencyKey:'apply-test-2'};
 await expect(f.service.aplicar(dto,'admin')).rejects.toThrow('No se aplicó ninguna');
 expect(f.state().products.every(p=>p.referenciaId==null)).toBe(true);expect(f.state().refs).toHaveLength(0);expect(f.state().audits).toHaveLength(0);
 const result=await f.service.aplicar({...dto,parcial:true},'admin');expect(result.aplicadas).toHaveLength(1);expect(result.fallos).toHaveLength(1);expect(f.state().proposals[1].estado).toBe('obsoleta');
});
test.each(['stockActual','vendedor','detalle','referenciaId'])('rechaza cambios posteriores en %s',async field=>{
 const f=fixture();await f.service.generar();f.state().products[0][field]=field==='detalle'?{modelo:'otro'}:field==='vendedor'?'Renato':99;
 await expect(f.service.aplicar({propuestaIds:[1],idempotencyKey:'changed-'+field},'admin')).rejects.toThrow('cambió');expect(f.state().audits).toHaveLength(0);
});
test('reutiliza el 409 de createReference y permite elegir una referencia o editar los datos',async()=>{
 const f=fixture();await f.service.generar();f.state().refs.push({id:9,activo:true});f.references.createReference.mockRejectedValue(new ConflictException({message:'Duplicada',id:9}));
 expect((await f.service.aplicar({propuestaIds:[1],idempotencyKey:'duplicate-reference'},'admin')).aplicadas[0].referenciaId).toBe(9);
 const g=fixture();await g.service.generar();g.state().refs.push({id:8,activo:true});await g.service.aplicar({propuestaIds:[1],idempotencyKey:'choose-reference',ajustes:[{propuestaId:1,referenciaId:8}]},'admin');expect(g.references.createReference).not.toHaveBeenCalled();
 const h=fixture();await h.service.generar();await h.service.aplicar({propuestaIds:[1],idempotencyKey:'edited-reference',ajustes:[{propuestaId:1,datosReferencia:{...h.state().proposals[0].datosReferenciaPropuesta,variante:'revisada'}}]},'admin');expect(h.state().refs[0].variante).toBe('revisada');
});
test('deshacer rechaza una versión antigua y preserva la auditoría',async()=>{
 const f=fixture();await f.service.generar();await f.service.aplicar({propuestaIds:[1],idempotencyKey:'undo-version'},'admin');f.state().products[0].referenciaId=999;
 await expect(f.service.deshacer({auditoriaIds:[1]},'admin')).rejects.toThrow('versión antigua');expect(f.state().audits).toHaveLength(1);
});
test('cambio informativo actualiza únicamente la tasa antes nula y nunca recalcula importes',async()=>{
 const f=fixture();const before=clone(f.state().values[0]);expect(await f.service.cambioInformativo(1,4)).toMatchObject({tipoCambioCompra:4,cambioImplicito:3.7});expect(f.state().values[0]).toEqual({...before,tipoCambioCompra:4});await expect(f.service.cambioInformativo(1,5)).rejects.toThrow('ya tiene');
});
test.each(['Recogido','recogido','RECOGIDO'])('tracking %s está disponible',estado=>expect(accessoryAvailable({...lot(),referenciaId:1,origen:'accesorio_importado',tracking:[{estado}] as any})).toBe(true));

test.each(['no original','original?'])('originalidad incierta %s obliga revisión',text=>{const p=lot();p.detalle.modelo='Apple cable USB-C 60W '+text;expect(proposeAccessory([p],[]).ambigua).toBe(true);});
