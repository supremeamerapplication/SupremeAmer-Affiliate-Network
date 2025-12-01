// storage.js - Frontend storage utilities for SupremeAmer

class SupremeAmerStorage {
  constructor() {
    this.buckets = {
      avatars: 'avatars',
      adImages: 'ad-images',
      adProofs: 'ad-proofs',
      documents: 'documents'
    };
  }

  // Generate unique file name
  generateFileName(userId, originalFileName, fileType = null) {
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const safeName = originalFileName.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
    const extension = originalFileName.split('.').pop();

    return `${userId}/${timestamp}_${randomString}_${safeName}`;
  }

  // Upload user avatar
  async uploadAvatar(file, userId) {
    try {
      const fileName = this.generateFileName(userId, file.name, 'avatar');
      const { data, error } = await supabase.storage
        .from(this.buckets.avatars)
        .upload(fileName, file);

      if (error) throw error;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from(this.buckets.avatars)
        .getPublicUrl(fileName);

      return {
        success: true,
        fileName,
        publicUrl,
        path: fileName
      };
    } catch (error) {
      console.error('Avatar upload error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Upload advert image
  async uploadAdImage(file, userId) {
    try {
      const fileName = this.generateFileName(userId, file.name, 'ad-image');
      const { data, error } = await supabase.storage
        .from(this.buckets.adImages)
        .upload(fileName, file, {
          cacheControl: '3600',
          upsert: false
        });

      if (error) throw error;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from(this.buckets.adImages)
        .getPublicUrl(fileName);

      return {
        success: true,
        fileName,
        publicUrl,
        path: fileName
      };
    } catch (error) {
      console.error('Ad image upload error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Upload proof screenshot (private)
  async uploadProofScreenshot(file, userId, participationId) {
    try {
      const fileName = this.generateFileName(userId, file.name, 'proof');
      const { data, error } = await supabase.storage
        .from(this.buckets.adProofs)
        .upload(fileName, file, {
          cacheControl: '0',
          upsert: false
        });

      if (error) throw error;

      // Get signed URL for private file (valid for 1 hour)
      const { data: { signedUrl } } = await supabase.storage
        .from(this.buckets.adProofs)
        .createSignedUrl(fileName, 3600);

      return {
        success: true,
        fileName,
        signedUrl,
        path: fileName
      };
    } catch (error) {
      console.error('Proof screenshot upload error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get proof screenshot URL (for admins and authorized users)
  async getProofScreenshotUrl(filePath) {
    try {
      const { data: { signedUrl }, error } = await supabase.storage
        .from(this.buckets.adProofs)
        .createSignedUrl(filePath, 3600); // 1 hour expiry

      if (error) throw error;

      return {
        success: true,
        url: signedUrl
      };
    } catch (error) {
      console.error('Error getting proof URL:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Delete file from storage
  async deleteFile(bucketName, filePath) {
    try {
      const { data, error } = await supabase.storage
        .from(bucketName)
        .remove([filePath]);

      if (error) throw error;

      return {
        success: true,
        message: 'File deleted successfully'
      };
    } catch (error) {
      console.error('File deletion error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get user storage usage
  async getUserStorageUsage(userId) {
    try {
      const { data, error } = await supabase.rpc('get_user_storage_usage', {
        user_uuid: userId
      });

      if (error) throw error;

      return {
        success: true,
        usage: data
      };
    } catch (error) {
      console.error('Storage usage fetch error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Validate file before upload
  validateFile(file, allowedTypes, maxSize) {
    const errors = [];

    // Check file type
    if (!allowedTypes.includes(file.type)) {
      errors.push(`File type ${file.type} is not allowed. Allowed types: ${allowedTypes.join(', ')}`);
    }

    // Check file size
    if (file.size > maxSize) {
      const maxSizeMB = (maxSize / 1024 / 1024).toFixed(2);
      errors.push(`File size ${(file.size / 1024 / 1024).toFixed(2)}MB exceeds maximum allowed ${maxSizeMB}MB`);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  // Get upload constraints for different file types
  getUploadConstraints(fileType) {
    const constraints = {
      avatar: {
        allowedTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
        maxSize: 5 * 1024 * 1024, // 5MB
        bucket: this.buckets.avatars
      },
      adImage: {
        allowedTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
        maxSize: 10 * 1024 * 1024, // 10MB
        bucket: this.buckets.adImages
      },
      proof: {
        allowedTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic'],
        maxSize: 10 * 1024 * 1024, // 10MB
        bucket: this.buckets.adProofs
      },
      document: {
        allowedTypes: ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf', 'image/heic'],
        maxSize: 5 * 1024 * 1024, // 5MB
        bucket: this.buckets.documents
      }
    };

    return constraints[fileType] || constraints.avatar;
  }
}

// Create global instance
const storageManager = new SupremeAmerStorage();

// Export for use in other files
if (typeof module !== 'undefined' && module.exports) {
  module.exports = storageManager;
}