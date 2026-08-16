import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createServiceSupabaseClient } from '../shared/supabase.client'
import { AuditService } from '../audit/audit.service'
import { AuditAction, AuditEntityType, AuditStatus } from '../audit/dto/audit.dto'

@Injectable()
export class PartnershipsService {
  private readonly logger = new Logger(PartnershipsService.name)
  private supabase

  constructor(private configService: ConfigService, private auditService: AuditService) {
    this.supabase = createServiceSupabaseClient(this.configService)
  }

  async getLogisticsApplications(filters: {
    page: number
    limit: number
    status?: string
    search?: string
  }) {
    try {
      let query = this.supabase
        .from('logistics_partner_applications')
        .select('*', { count: 'exact' })

      // Apply filters
      if (filters.status) {
        query = query.eq('status', filters.status)
      }

      if (filters.search) {
        query = query.or(`company_name.ilike.%${filters.search}%,contact_email.ilike.%${filters.search}%,tracking_id.ilike.%${filters.search}%`)
      }

      // Apply pagination
      const page = filters.page || 1
      const limit = filters.limit || 20
      const from = (page - 1) * limit
      query = query.range(from, from + limit - 1)

      // Order by created_at desc
      query = query.order('created_at', { ascending: false })

      const { data: applications, error, count } = await query

      if (error) {
        this.logger.error('Failed to fetch logistics applications:', error)
        throw new Error('Failed to fetch applications')
      }

      return {
        applications: applications || [],
        total: count || 0,
        page,
        limit,
      }
    } catch (error) {
      this.logger.error('Error in getLogisticsApplications:', error)
      throw error
    }
  }

  async getGeneralApplications(filters: {
    page: number
    limit: number
    status?: string
    search?: string
  }) {
    try {
      let query = this.supabase
        .from('general_partnerships')
        .select('*', { count: 'exact' })

      // Apply filters
      if (filters.status) {
        query = query.eq('status', filters.status)
      }

      if (filters.search) {
        query = query.or(`name.ilike.%${filters.search}%,email.ilike.%${filters.search}%,company.ilike.%${filters.search}%`)
      }

      // Apply pagination
      const page = filters.page || 1
      const limit = filters.limit || 20
      const from = (page - 1) * limit
      query = query.range(from, from + limit - 1)

      // Order by created_at desc
      query = query.order('created_at', { ascending: false })

      const { data: applications, error, count } = await query

      if (error) {
        this.logger.error('Failed to fetch general applications:', error)
        throw new Error('Failed to fetch applications')
      }

      return {
        applications: applications || [],
        total: count || 0,
        page,
        limit,
      }
    } catch (error) {
      this.logger.error('Error in getGeneralApplications:', error)
      throw error
    }
  }

  async createGeneralApplication(applicationData: {
    name: string
    email: string
    company?: string
    phone?: string
    partnershipType: string
    message: string
  }) {
    try {
      const { data: application, error } = await this.supabase
        .from('general_partnerships')
        .insert({
          name: applicationData.name,
          email: applicationData.email,
          company: applicationData.company,
          phone: applicationData.phone,
          partnership_type: applicationData.partnershipType,
          message: applicationData.message,
          status: 'pending',
        })
        .select()
        .single()

      if (error) {
        this.logger.error('Failed to create general application:', error)
        
        // Handle duplicate email error more gracefully
        if (error.code === '23505' && error.details?.includes('email')) {
          throw new BadRequestException('An application with this email address already exists. Please use a different email or contact support.')
        }
        
        throw new BadRequestException('Failed to create application')
      }

      // Skip audit logging for public submissions (no staff user to associate with)
      this.logger.log(`General partnership application created: ${application.id}`)
      return application
    } catch (error) {
      this.logger.error('Error in createGeneralApplication:', error)
      throw error
    }
  }

  async getLogisticsApplicationById(id: string) {
    try {
      const { data: application, error } = await this.supabase
        .from('logistics_partner_applications')
        .select('*')
        .eq('id', id)
        .single()

      if (error) {
        this.logger.error('Failed to fetch logistics application:', error)
        throw new Error('Application not found')
      }

      return application
    } catch (error) {
      this.logger.error('Error in getLogisticsApplicationById:', error)
      throw error
    }
  }

  async getGeneralApplicationById(id: string) {
    try {
      const { data: application, error } = await this.supabase
        .from('general_partnerships')
        .select('*')
        .eq('id', id)
        .single()

      if (error) {
        this.logger.error('Failed to fetch general application:', error)
        throw new Error('Application not found')
      }

      return application
    } catch (error) {
      this.logger.error('Error in getGeneralApplicationById:', error)
      throw error
    }
  }

  async verifyLogisticsApplication(id: string, adminId: string, notes?: string) {
    try {
      const { error } = await this.supabase
        .from('logistics_partner_applications')
        .update({
          status: 'verified',
          verified_at: new Date().toISOString(),
          verified_by: adminId,
          admin_notes: notes,
        })
        .eq('id', id)

      if (error) {
        this.logger.error('Failed to verify logistics application:', error)
        throw new Error('Failed to verify application')
      }

      // Log audit
      await this.auditService.log({
        staffId: adminId,
        action: AuditAction.VERIFY,
        entityType: AuditEntityType.LOGISTICS_PARTNERSHIP,
        entityId: id,
        details: `Logistics partnership application verified`,
        status: AuditStatus.SUCCESS,
      })

      this.logger.log(`Logistics application verified: ${id}`)
    } catch (error) {
      this.logger.error('Error in verifyLogisticsApplication:', error)
      throw error
    }
  }

  async rejectLogisticsApplication(id: string, adminId: string, reason: string, notes?: string) {
    try {
      const { error } = await this.supabase
        .from('logistics_partner_applications')
        .update({
          status: 'rejected',
          rejected_at: new Date().toISOString(),
          rejected_by: adminId,
          rejection_reason: reason,
          admin_notes: notes,
        })
        .eq('id', id)

      if (error) {
        this.logger.error('Failed to reject logistics application:', error)
        throw new Error('Failed to reject application')
      }

      // Log audit
      await this.auditService.log({
        staffId: adminId,
        action: AuditAction.REJECT,
        entityType: AuditEntityType.LOGISTICS_PARTNERSHIP,
        entityId: id,
        details: `Logistics partnership application rejected. Reason: ${reason}`,
        status: AuditStatus.SUCCESS,
      })

      this.logger.log(`Logistics application rejected: ${id}`)
    } catch (error) {
      this.logger.error('Error in rejectLogisticsApplication:', error)
      throw error
    }
  }

  async approveGeneralApplication(id: string, adminId: string, notes?: string) {
    try {
      const { error } = await this.supabase
        .from('general_partnerships')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          approved_by: adminId,
          admin_notes: notes,
        })
        .eq('id', id)

      if (error) {
        this.logger.error('Failed to approve general application:', error)
        throw new Error('Failed to approve application')
      }

      // Log audit
      await this.auditService.log({
        staffId: adminId,
        action: AuditAction.VERIFY,
        entityType: AuditEntityType.LOGISTICS_PARTNERSHIP,
        entityId: id,
        details: `General partnership application approved`,
        status: AuditStatus.SUCCESS,
      })

      this.logger.log(`General application approved: ${id}`)
    } catch (error) {
      this.logger.error('Error in approveGeneralApplication:', error)
      throw error
    }
  }

  async rejectGeneralApplication(id: string, adminId: string, reason: string, notes?: string) {
    try {
      const { error } = await this.supabase
        .from('general_partnerships')
        .update({
          status: 'rejected',
          rejected_at: new Date().toISOString(),
          rejected_by: adminId,
          rejection_reason: reason,
          admin_notes: notes,
        })
        .eq('id', id)

      if (error) {
        this.logger.error('Failed to reject general application:', error)
        throw new Error('Failed to reject application')
      }

      // Log audit
      await this.auditService.log({
        staffId: adminId,
        action: AuditAction.REJECT,
        entityType: AuditEntityType.LOGISTICS_PARTNERSHIP,
        entityId: id,
        details: `General partnership application rejected. Reason: ${reason}`,
        status: AuditStatus.SUCCESS,
      })

      this.logger.log(`General application rejected: ${id}`)
    } catch (error) {
      this.logger.error('Error in rejectGeneralApplication:', error)
      throw error
    }
  }
}
