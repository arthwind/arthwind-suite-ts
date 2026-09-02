import fs from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { arthnexApi } from './arthnexApi'
import {
  extractHorizonTaskIdsFromXlsx,
  horizonProcessarFromArthnex,
  listXlsxSheets,
} from './horizon'

describe('horizon service', () => {
  const patternXlsxPath =
    '/home/pedroo/Downloads/Pattern Hybrid Processing Status.xlsx'

  it('listXlsxSheets should return all worksheets from Pattern status workbook', async () => {
    if (!fs.existsSync(patternXlsxPath)) {
      console.warn(
        'Pattern xlsx file not found at path, skipping real file test'
      )
      return
    }

    const res = await listXlsxSheets(patternXlsxPath)
    expect(res.success).toBe(true)
    expect(res.sheets.length).toBeGreaterThan(5)

    const henvey = res.sheets.find(s => s.name.toLowerCase().includes('henvey'))
    expect(henvey).toBeDefined()
    expect(henvey?.name).toBe('Henvey Inlet')
  })

  it('extractHorizonTaskIdsFromXlsx should extract all 87 turbines and valid UUID task IDs for Henvey Inlet', async () => {
    if (!fs.existsSync(patternXlsxPath)) {
      return
    }

    const res = await extractHorizonTaskIdsFromXlsx(
      patternXlsxPath,
      'Henvey Inlet'
    )
    expect(res.success).toBe(true)
    expect(res.sheet).toBe('Henvey Inlet')
    expect(res.count).toBe(87)

    // Verify key sample turbines and their UUIDs
    expect(res.taskMap['HIW_003']).toBe('b1671e96-d625-4aca-97f7-35db3fe1b228')
    expect(res.taskMap['HIW_007']).toBe('3585659f-4caa-4d1f-84dd-1def4ee990ae')
    expect(res.taskMap['HIW_122']).toBe('56733158-55e8-4f42-9705-3c6a362d7d71')
  })

  it('horizonProcessarFromArthnex should correctly process selective turbines (e.g. 10 turbines) and produce a valid ZIP package', async () => {
    // Mock arthnexApi methods
    const mockTurbines = Array.from({ length: 25 }, (_, i) => {
      const tNum = String(i + 1).padStart(3, '0')
      const name = `HIW_${tNum}`
      return {
        id: i + 1,
        workorder_id: 'WO-TEST-4682',
        turbine_id: i + 1,
        turbine: name,
        workorder_description: 'Henvey Inlet Test',
        windfarm_id: 101,
        is_upload_validated: true,
        windblades: [
          {
            windblade_id: (i + 1) * 10 + 1,
            wo_package_id: i + 1,
            blade: 'Blade A',
            blade_letter: 'A',
            blade_id: 1,
            blade_model: 'GE-68',
            blade_size: '68m',
            has_gallery: true,
            is_360: false,
          },
        ],
      }
    })

    vi.spyOn(arthnexApi, 'getTurbinesAndBladesByWo').mockResolvedValue(
      mockTurbines as any
    )
    vi.spyOn(arthnexApi, 'getTechnicianAndDateByTurbine').mockResolvedValue({
      technician: 'Test Tech',
      date: '2026-08-15',
      leader: 'ALLAN THIAGO',
      technicians: ['Test Tech'],
    })
    vi.spyOn(arthnexApi, 'getDefectsByBlade').mockResolvedValue([
      {
        id: 991,
        damage_id: 991,
        name: 'Delamination',
        severity: 3,
        status: 'Active',
        location: 45.2,
        surface: 'External',
        side: 'PS',
        coordinates: '[[100, 200], [150, 250]]',
        image_url: 'https://cdn.arthnex.com/photos/HIW_001_A_45.jpg',
      } as any,
    ])

    // Select exactly 10 specific turbines
    const selectedTen = [
      'HIW_001',
      'HIW_002',
      'HIW_003',
      'HIW_004',
      'HIW_005',
      'HIW_006',
      'HIW_007',
      'HIW_008',
      'HIW_009',
      'HIW_010',
    ]

    const taskMap: Record<string, string> = {
      HIW_001: 'uuid-task-001',
      HIW_002: 'uuid-task-002',
      HIW_003: 'uuid-task-003',
      HIW_004: 'uuid-task-004',
      HIW_005: 'uuid-task-005',
      HIW_006: 'uuid-task-006',
      HIW_007: 'uuid-task-007',
      HIW_008: 'uuid-task-008',
      HIW_009: 'uuid-task-009',
      HIW_010: 'uuid-task-010',
    }

    const tmpZipPath = path.join('/tmp', `test_horizon_4682_${Date.now()}.zip`)

    const result = await horizonProcessarFromArthnex({
      workorderId: 'WO-TEST-4682',
      taskMap,
      selectedTurbines: selectedTen,
      siteName: 'Henvey Inlet',
      outputPath: tmpZipPath,
    })

    expect(result.success).toBe(true)
    expect(result.summaryCount).toBe(10)
    expect(result.damagesCount).toBe(10)
    expect(fs.existsSync(tmpZipPath)).toBe(true)

    // Clean up temporary test zip
    if (fs.existsSync(tmpZipPath)) {
      fs.unlinkSync(tmpZipPath)
    }
  })
})
