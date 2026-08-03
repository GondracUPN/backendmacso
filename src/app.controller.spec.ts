import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppController, matchesAppleProductTitle } from './app.controller';
import { AppService } from './app.service';
import { AnalyticsService } from './analytics/analytics.service';
import { EbayPawn } from './ebay-pawn.entity';
import { EbaySearchItem } from './ebay-search-item.entity';
import { EbaySearchState } from './ebay-search-state.entity';
import { EbayViewedItem } from './ebay-viewed-item.entity';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: AnalyticsService,
          useValue: {
            summaryCached: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(EbayPawn),
          useValue: {
            create: jest.fn((value) => value),
            find: jest.fn(),
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(EbaySearchItem),
          useValue: {
            create: jest.fn((value) => value),
            find: jest.fn(),
            findAndCount: jest.fn(),
            upsert: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(EbaySearchState),
          useValue: {
            create: jest.fn((value) => value),
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(EbayViewedItem),
          useValue: {
            create: jest.fn((value) => value),
            find: jest.fn(),
            upsert: jest.fn(),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });
});

describe('identificacion de productos Apple recientes', () => {
  it.each([
    'Apple MacBook Pro 14 M3 Pro A2918 18GB 512GB',
    'A2918 Apple laptop 14 inch M3 Pro',
    'Apple M3 Pro 14-inch 18GB 512GB',
    'Apple MacBook Pro MTL73LL/A 14-inch',
    'Apple MacBook Neo 13 A18 Pro 8GB 256GB',
    'Apple A3404 13-inch 8GB 512GB',
    'MHFF4LL/A Apple laptop 13-inch Indigo',
    'Apple iPad Pro A2918 M3 14 inch',
    'Apple Watch Series 10 GPS Cellular 46mm A3000',
    'Apple Watch SE 2 GPS 44mm A2723',
    'Apple Watch Ultra 2 GPS Cellular A2986',
    'Apple iMac M1 24-inch A2438',
    'Apple Mac mini M4 Pro A3239',
  ])('acepta un equipo real por familia, chip o identificador: %s', (title) => {
    expect(matchesAppleProductTitle({ title })).toBe(true);
  });

  it.each([
    'Empty box only for Apple MacBook Pro A2918',
    'Apple M3 MacBook replacement logic board A2918',
    'Protective case for Apple iPad Pro M4 A2836',
    'Apple Watch Ultra 2 charging stand dock',
    'Apple Watch Ultra band strap 49mm',
    'Samsung Galaxy tablet A2918',
  ])('rechaza caja, repuesto, accesorio u otra marca: %s', (title) => {
    expect(matchesAppleProductTitle({ title })).toBe(false);
  });
});
