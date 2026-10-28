import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { AccesoriosController } from './accesorios.controller';
import { AccesoriosService } from './accesorios.service';
import { VinculosService } from './vinculos.service';
describe('revisión de accesorios: autorización HTTP',()=>{
 let app:any;const links={generar:jest.fn(async()=>({nuevas:0})),aplicar:jest.fn(async()=>({aplicadas:[]}))};
 const jwt=new JwtService({secret:'test-accessory-secret'});const token=role=>jwt.sign({sub:7,username:'test',role});
 beforeAll(async()=>{const module=await Test.createTestingModule({controllers:[AccesoriosController],providers:[JwtStrategy,{provide:ConfigService,useValue:{get:()=> 'test-accessory-secret'}},{provide:AccesoriosService,useValue:{}},{provide:VinculosService,useValue:links}]}).compile();app=module.createNestApplication();app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.init();});
 afterAll(async()=>app.close());
 test.each([['post','/accesorios/vinculos/generar'],['get','/accesorios/vinculos'],['get','/accesorios/vinculos/auditoria'],['post','/accesorios/vinculos/aplicar'],['post','/accesorios/vinculos/deshacer'],['post','/accesorios/vinculos/1/rechazar'],['patch','/accesorios/lotes/1/tipo-cambio-informativo']])('%s %s exige admin',async(method,path)=>{await request(app.getHttpServer())[method](path).send({}).expect(401);await request(app.getHttpServer())[method](path).auth(token('user'),{type:'bearer'}).send({}).expect(403);});
 test('admin confirma con identidad del JWT; DTO rechaza parcial no booleano y tasas inválidas',async()=>{await request(app.getHttpServer()).post('/accesorios/vinculos/aplicar').auth(token('admin'),{type:'bearer'}).send({propuestaIds:[1],idempotencyKey:'http-test-key'}).expect(201);expect(links.aplicar).toHaveBeenCalledWith(expect.objectContaining({propuestaIds:[1]}),'7:test');await request(app.getHttpServer()).post('/accesorios/vinculos/aplicar').auth(token('admin'),{type:'bearer'}).send({propuestaIds:[1],idempotencyKey:'http-test-key',parcial:'true'}).expect(400);await request(app.getHttpServer()).patch('/accesorios/lotes/1/tipo-cambio-informativo').auth(token('admin'),{type:'bearer'}).send({tipoCambioCompra:-1,valorSoles:400}).expect(400);});
});
