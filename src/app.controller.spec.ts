import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppController, buildEbayPriceFilters, isApplePartTitle, matchesAppleProductTitle } from './app.controller';
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
    'Harper Veyland MacBook Pro 16-inch M4 Pro & M4 Max User Guide for Adults',
    '2X LCD Double Side Adhesive Strip Sticker Tape Set MacBook Pro A3185 A3112',
    'OEM replacement LCD screen assembly for MacBook Pro A3186',
    'MacBook Air 13.6 Inch Case with Touch ID, M4 A3240 M3 A3113 M2 A2681, Smooth',
    'MacBook Air 13 M4 2025 A3240 A3113 Left & Right Speakers Wi-Fi Antennas OEM',
    'NEW mCover CASE for 13.6 Apple MacBook Air A2681 A3113 A3240 M3 M4',
  ])('rechaza caja, repuesto, accesorio u otra marca: %s', (title) => {
    expect(matchesAppleProductTitle({ title })).toBe(false);
  });

  it.each([
    'Macbook Air 13 Trackpad Grey A3113',
    'Macbook Air 13 Type C Port 821-04807 A3113 A3240',
    'For MacBook Air M3 13 Inch A3113 Earphone Jack Audio',
    'For MacBook Air Retina 13.6 M3 A3113 Microphone Flex',
    'Macbook Air M3 13 / 15 A3113 A3114 US English Version Keycaps',
    'Macbook Air 13 A3113 HeadPhone Audio Jack Board',
    'Macbook Air 13 A3113 DC Jack MagSafe Board',
  ])('separa componentes aunque eBay los marque New o Used: %s', (title) => {
    expect(isApplePartTitle(title)).toBe(true);
    expect(matchesAppleProductTitle({ title, conditionId: '3000' })).toBe(false);
    expect(matchesAppleProductTitle({ title, conditionId: '3000' }, { allowParts: true })).toBe(true);
  });

  it('no confunde un equipo completo que menciona un componente', () => {
    const title = 'Apple MacBook Air M3 13-inch 16GB 512GB SSD with keyboard';
    expect(isApplePartTitle(title)).toBe(false);
    expect(matchesAppleProductTitle({ title })).toBe(true);
  });
});

describe('filtro de precio de eBay', () => {
  it('crea rangos mínimo, máximo y entre precios en USD', () => {
    expect(buildEbayPriceFilters(100, 500)).toEqual(['price:[100..500]', 'priceCurrency:USD']);
    expect(buildEbayPriceFilters(100, undefined)).toEqual(['price:[100]', 'priceCurrency:USD']);
    expect(buildEbayPriceFilters(undefined, 500)).toEqual(['price:[..500]', 'priceCurrency:USD']);
  });

  it('ordena automáticamente un rango ingresado al revés', () => {
    expect(buildEbayPriceFilters(500, 100)).toEqual(['price:[100..500]', 'priceCurrency:USD']);
  });
});
