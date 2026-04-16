export class CreateGeneralPartnershipDto {
  name: string;
  email: string;
  company: string;
  phone?: string;
  partnership_type: string;
  message?: string;
}

export class UpdatePartnershipStatusDto {
  status: string;
}
