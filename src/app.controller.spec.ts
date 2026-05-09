import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppController } from './app.controller';
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
