import {Injectable} from '@nestjs/common';
import {Brand, Prisma} from '@prisma/client';
import {AuditService} from '../audit/audit.service';
import {PrismaService} from '../prisma/prisma.service';
import type {BrandOfferDto, BrandProductDto, UpdateBrandDto} from './brand.dto';

export type BrandFacts = Omit<Brand, 'products' | 'approvedOffers'> & {
  products: BrandProductDto[];
  approvedOffers: BrandOfferDto[];
};

@Injectable()
export class BrandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(workspaceId: string): Promise<BrandFacts> {
    const existing = await this.prisma.brand.findUnique({where: {workspaceId}});
    const brand =
      existing ||
      (await this.prisma.brand.create({
        data: {
          workspaceId,
          name: (await this.prisma.workspace.findUniqueOrThrow({where: {id: workspaceId}})).name,
        },
      }));
    return {
      ...brand,
      products: Array.isArray(brand.products) ? (brand.products as unknown as BrandProductDto[]) : [],
      approvedOffers: Array.isArray(brand.approvedOffers)
        ? (brand.approvedOffers as unknown as BrandOfferDto[])
        : [],
    };
  }

  async update(workspaceId: string, actorId: string, input: UpdateBrandDto) {
    const current = await this.get(workspaceId);
    await this.prisma.brand.update({
      where: {id: current.id},
      data: {
        ...input,
        products: input.products as Prisma.InputJsonValue | undefined,
        approvedOffers: input.approvedOffers as Prisma.InputJsonValue | undefined,
        doNotSay: input.doNotSay?.map(term => term.trim()).filter(Boolean),
        ctas: input.ctas?.map(cta => cta.trim()).filter(Boolean),
      },
    });
    await this.prisma.workspace.updateMany({
      where: {id: workspaceId, onboardingStep: 'brand'},
      data: {onboardingStep: 'channels'},
    });
    await this.audit.record({
      workspaceId,
      actorId,
      action: 'brand.updated',
      entityType: 'brand',
      entityId: current.id,
      metadata: {fields: Object.keys(input)},
    });
    return this.get(workspaceId);
  }
}
