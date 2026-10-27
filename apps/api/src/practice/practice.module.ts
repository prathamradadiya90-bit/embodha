import { Module } from '@nestjs/common';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { PracticeController } from './practice.controller';
import { PracticeService } from './practice.service';

@Module({
  imports: [CatalogueModule],
  controllers: [PracticeController],
  providers: [PracticeService],
})
export class PracticeModule {}
